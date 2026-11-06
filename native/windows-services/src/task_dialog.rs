//! Windows task dialogs (`TaskDialogIndirect`). The call runs its own message
//! loop until the dialog ends, so the caller runs it on a dedicated thread;
//! this module never touches GPUI's thread. A dialog is closed from another
//! thread by posting `TDM_CLICK_BUTTON` to it.
//!
//! `TaskDialogIndirect` exists only in Common Controls 6, which the host's
//! manifest requests. It is resolved at run time, so a process without that
//! manifest reports the service unavailable instead of failing to start.
#![allow(
    unsafe_code,
    reason = "the reviewed task dialog calls of this boundary"
)]

use crate::task_dialog_spec::{Pressed, TaskDialogSpec, pressed};
use crate::wide::terminated;
use std::ffi::OsStr;
use std::io;
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};
use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows_sys::Win32::UI::Controls::{
    TASKDIALOG_BUTTON, TASKDIALOGCONFIG, TDF_ALLOW_DIALOG_CANCELLATION,
    TDF_POSITION_RELATIVE_TO_WINDOW, TDM_CLICK_BUTTON, TDN_CREATED, TDN_DESTROYED,
};
use windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW;

/// TEMPORARY hosted-run diagnostics (removed once #239 is verified).
pub fn trace(line: &str) {
    use std::io::Write;
    if let Some(dir) = std::env::var_os("BUN_NATIVE_TASK_DIALOG_EVIDENCE") {
        let path = std::path::Path::new(&dir).join("host-trace.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

type TaskDialogIndirect =
    unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut i32) -> i32;

fn entry_point() -> Option<TaskDialogIndirect> {
    static ENTRY: OnceLock<Option<TaskDialogIndirect>> = OnceLock::new();
    *ENTRY.get_or_init(|| {
        let library = terminated(OsStr::new("comctl32.dll")).ok()?;
        // SAFETY: a NUL-terminated name of a system library.
        let module = unsafe { LoadLibraryW(library.as_ptr()) };
        if module.is_null() {
            return None;
        }
        // SAFETY: a NUL-terminated export name of the module just loaded.
        let address = unsafe { GetProcAddress(module, c"TaskDialogIndirect".as_ptr().cast()) }?;
        // SAFETY: `TaskDialogIndirect` has exactly this signature.
        Some(unsafe {
            std::mem::transmute::<unsafe extern "system" fn() -> isize, TaskDialogIndirect>(address)
        })
    })
}

/// Whether the process can show task dialogs: Common Controls 6 is active.
pub fn available() -> bool {
    entry_point().is_some()
}

/// Closes a dialog from any thread, whether or not it has been created yet.
#[derive(Default)]
pub struct Control {
    window: AtomicIsize,
    close: AtomicBool,
    first_button: AtomicIsize,
}

impl Control {
    pub fn new() -> Self {
        Self::default()
    }

    /// End the dialog as if its first button were pressed. Safe to call before
    /// the dialog exists (it ends as soon as it appears), after it ended and
    /// more than once.
    pub fn close(&self) {
        self.close.store(true, Ordering::SeqCst);
        self.click();
    }

    fn click(&self) {
        let window = self.window.load(Ordering::SeqCst);
        if window != 0 {
            // SAFETY: posting a message to a window handle is sound for any
            // value; a handle that no longer exists just fails.
            unsafe {
                PostMessageW(
                    window as HWND,
                    TDM_CLICK_BUTTON as u32,
                    self.first_button.load(Ordering::SeqCst) as WPARAM,
                    0 as LPARAM,
                );
            }
        }
    }
}

struct Callback<'a> {
    control: &'a Control,
    created: Mutex<Option<Box<dyn FnOnce() + Send + 'a>>>,
}

unsafe extern "system" fn callback(
    window: HWND,
    notification: u32,
    _wparam: WPARAM,
    _lparam: LPARAM,
    data: isize,
) -> i32 {
    // SAFETY: `data` is the address of the `Callback` that `show` keeps alive
    // for the whole `TaskDialogIndirect` call that invokes this function.
    let state = unsafe { &*(data as *const Callback<'_>) };
    trace(&format!("callback notification={notification}"));
    if notification == TDN_CREATED as u32 {
        state
            .control
            .window
            .store(window as isize, Ordering::SeqCst);
        let created = state.created.lock().ok().and_then(|mut slot| slot.take());
        if let Some(created) = created {
            created();
        }
        // A close requested before the dialog existed ends it now.
        if state.control.close.load(Ordering::SeqCst) {
            state.control.click();
        }
    } else if notification == TDN_DESTROYED as u32 {
        state.control.window.store(0, Ordering::SeqCst);
    }
    0
}

/// Show the dialog modally for `owner` (an `HWND`, or 0 for none) and wait
/// for it to end. `created` runs on this thread once the dialog exists.
pub fn show(
    owner: isize,
    spec: &TaskDialogSpec,
    control: &Control,
    created: impl FnOnce() + Send,
) -> io::Result<Pressed> {
    spec.validate()
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?;
    let entry = entry_point().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "Common Controls 6 is not active in this process",
        )
    })?;
    let title = terminated(OsStr::new(&spec.title))?;
    let instruction = terminated(OsStr::new(&spec.instruction))?;
    let content = spec
        .content
        .as_deref()
        .map(|content| terminated(OsStr::new(content)))
        .transpose()?;
    let labels = spec
        .buttons
        .iter()
        .map(|label| terminated(OsStr::new(label)))
        .collect::<io::Result<Vec<_>>>()?;
    let buttons: Vec<TASKDIALOG_BUTTON> = labels
        .iter()
        .enumerate()
        .map(|(index, label)| TASKDIALOG_BUTTON {
            nButtonID: TaskDialogSpec::button_id(index),
            pszButtonText: label.as_ptr(),
        })
        .collect();
    control
        .first_button
        .store(TaskDialogSpec::button_id(0) as isize, Ordering::SeqCst);
    let state = Callback {
        control,
        created: Mutex::new(Some(Box::new(created))),
    };
    let config = TASKDIALOGCONFIG {
        cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: owner as HWND,
        dwFlags: TDF_POSITION_RELATIVE_TO_WINDOW
            | if spec.cancellable {
                TDF_ALLOW_DIALOG_CANCELLATION
            } else {
                0
            },
        pszWindowTitle: title.as_ptr(),
        pszMainInstruction: instruction.as_ptr(),
        pszContent: content
            .as_ref()
            .map_or(std::ptr::null(), |text| text.as_ptr()),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: TaskDialogSpec::button_id(spec.default_button),
        pfCallback: Some(callback),
        lpCallbackData: std::ptr::addr_of!(state) as isize,
        ..Default::default()
    };
    let mut result = 0i32;
    trace(&format!(
        "calling TaskDialogIndirect owner={owner} cb={}",
        size_of::<TASKDIALOGCONFIG>()
    ));
    // SAFETY: `config` and everything it points to (the strings, the button
    // array and `state`) outlive this call, which returns only after the
    // dialog and every callback have ended. The out pointer is valid; the
    // optional outputs are null.
    let status = unsafe {
        entry(
            &config,
            &mut result,
            std::ptr::null_mut::<i32>(),
            std::ptr::null_mut::<i32>(),
        )
    };
    control.window.store(0, Ordering::SeqCst);
    trace(&format!(
        "TaskDialogIndirect returned status={status:#x} result={result}"
    ));
    if status < 0 {
        return Err(io::Error::from_raw_os_error(status));
    }
    pressed(spec.buttons.len(), result).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "the task dialog reported a button it did not offer",
        )
    })
}
