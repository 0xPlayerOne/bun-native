//! Win32 popup menus for OS context menus. `TrackPopupMenuEx` runs a modal
//! menu loop on the calling thread, which must own the owner window, and
//! returns the chosen command. The loop dispatches the thread's other window
//! messages. GPUI posts one wake message for its queued work and posts no
//! other while a task of that queue is running, so a menu entered from a
//! GPUI task would stall every later task, including a close request. The
//! menu is therefore entered from this module's own message-only window,
//! from a posted message, outside GPUI's task queue: while it tracks, GPUI's
//! wake messages are dispatched by the menu loop and its tasks keep running.
#![allow(unsafe_code, reason = "the reviewed popup menu calls of this boundary")]

use crate::context_menu_spec::MenuNode;
use crate::wide::terminated;
use std::cell::{Cell, RefCell};
use std::ffi::OsStr;
use std::io;
use std::rc::Rc;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, EndMenu, HMENU,
    HWND_MESSAGE, MF_CHECKED, MF_GRAYED, MF_POPUP, MF_SEPARATOR, MF_STRING, PostMessageW,
    RegisterClassW, SetForegroundWindow, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON,
    TPM_TOPALIGN, TrackPopupMenuEx, WM_APP, WM_NULL, WNDCLASSW,
};

/// Destroys the top-level menu, and with it every attached submenu.
struct Menu(HMENU);

impl Drop for Menu {
    fn drop(&mut self) {
        // SAFETY: a menu this module created and has not destroyed.
        unsafe { DestroyMenu(self.0) };
    }
}

fn append(menu: HMENU, nodes: &[MenuNode]) -> io::Result<()> {
    for node in nodes {
        // SAFETY: `menu` is a live popup menu; every string is NUL-terminated
        // and copied by `AppendMenuW` before it returns.
        let appended = match node {
            MenuNode::Item {
                command,
                text,
                enabled,
                checked,
            } => {
                let text = terminated(OsStr::new(text))?;
                let flags = MF_STRING
                    | if *enabled { 0 } else { MF_GRAYED }
                    | if *checked { MF_CHECKED } else { 0 };
                unsafe { AppendMenuW(menu, flags, *command as usize, text.as_ptr()) }
            }
            MenuNode::Separator => unsafe { AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null()) },
            MenuNode::Submenu {
                text,
                enabled,
                items,
            } => {
                let text = terminated(OsStr::new(text))?;
                // SAFETY: creates an empty popup menu or returns null.
                let submenu = unsafe { CreatePopupMenu() };
                if submenu.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let submenu = Menu(submenu);
                append(submenu.0, items)?;
                let flags = MF_POPUP | MF_STRING | if *enabled { 0 } else { MF_GRAYED };
                let appended =
                    unsafe { AppendMenuW(menu, flags, submenu.0 as usize, text.as_ptr()) };
                if appended != 0 {
                    // The parent owns and destroys it now.
                    std::mem::forget(submenu);
                }
                appended
            }
        };
        if appended == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Show the menu at `(x, y)` physical pixels of `owner`'s client area (an
/// `HWND`) and wait for it to close. Returns the chosen command, or `None`
/// when the menu was dismissed or ended with [`end`].
fn track(owner: isize, x: i32, y: i32, nodes: &[MenuNode]) -> io::Result<Option<u32>> {
    let window = owner as HWND;
    // SAFETY: creates an empty popup menu or returns null.
    let menu = unsafe { CreatePopupMenu() };
    if menu.is_null() {
        return Err(io::Error::last_os_error());
    }
    let menu = Menu(menu);
    append(menu.0, nodes)?;
    let mut point = POINT { x, y };
    // SAFETY: `point` is a valid out pointer; an invalid window just fails.
    if unsafe { ClientToScreen(window, &mut point) } == 0 {
        return Err(io::Error::other("the owner window has no client area"));
    }
    // The documented pattern: the owner must be foreground, or the menu does
    // not close when the user clicks elsewhere; WM_NULL lets the second
    // invocation behave.
    // SAFETY: plain window-handle calls; an invalid handle just fails.
    let chosen = unsafe {
        SetForegroundWindow(window);
        let chosen = TrackPopupMenuEx(
            menu.0,
            TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_LEFTALIGN | TPM_TOPALIGN,
            point.x,
            point.y,
            window,
            std::ptr::null(),
        );
        PostMessageW(window, WM_NULL, 0, 0);
        chosen
    };
    Ok(u32::try_from(chosen).ok().filter(|command| *command > 0))
}

/// End the menu this thread is tracking, if any.
pub fn end() {
    // SAFETY: no arguments; ends the calling thread's active menu, if any.
    unsafe { EndMenu() };
}

const WM_SHOW_MENU: u32 = WM_APP + 0x4D;

struct Job {
    owner: isize,
    x: i32,
    y: i32,
    nodes: Vec<MenuNode>,
    closed: Rc<Cell<bool>>,
    tracking: Box<dyn FnOnce()>,
    done: Box<dyn FnOnce(io::Result<Option<u32>>)>,
}

thread_local! {
    /// This thread's message-only window, created on first use.
    static WINDOW: Cell<HWND> = const { Cell::new(std::ptr::null_mut()) };
    static JOBS: RefCell<Vec<Job>> = const { RefCell::new(Vec::new()) };
}

unsafe extern "system" fn procedure(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message != WM_SHOW_MENU {
        // SAFETY: the default procedure for this window's other messages.
        return unsafe { DefWindowProcW(window, message, wparam, lparam) };
    }
    // Jobs are taken one at a time, so one posted message runs one job.
    let job = JOBS.with(|jobs| {
        let mut jobs = jobs.borrow_mut();
        (!jobs.is_empty()).then(|| jobs.remove(0))
    });
    if let Some(job) = job {
        let result = if job.closed.get() {
            Ok(None)
        } else {
            (job.tracking)();
            track(job.owner, job.x, job.y, &job.nodes)
        };
        let result = result.map(|chosen| chosen.filter(|_| !job.closed.get()));
        (job.done)(result);
    }
    0
}

fn window() -> io::Result<HWND> {
    if let Some(window) = WINDOW.with(|window| Some(window.get()).filter(|w| !w.is_null())) {
        return Ok(window);
    }
    let name = terminated(OsStr::new("BunNativeContextMenuHost"))?;
    // SAFETY: a null module name returns this process's executable module.
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class = WNDCLASSW {
        lpfnWndProc: Some(procedure),
        hInstance: instance,
        lpszClassName: name.as_ptr(),
        // SAFETY: the remaining fields are plain integers and nullable handles.
        ..unsafe { std::mem::zeroed() }
    };
    // SAFETY: `class` points at a NUL-terminated name that outlives the call;
    // registering an existing class fails harmlessly and creation still works.
    unsafe { RegisterClassW(&class) };
    // SAFETY: a message-only window of the class registered above.
    let window = unsafe {
        CreateWindowExW(
            0,
            name.as_ptr(),
            name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        )
    };
    if window.is_null() {
        return Err(io::Error::last_os_error());
    }
    WINDOW.with(|cell| cell.set(window));
    Ok(window)
}

/// Schedule the menu on this (the owner's) thread. `tracking` runs just
/// before the menu starts tracking. `done` runs once with
/// the chosen command, `None` when dismissed or closed first. Setting
/// `closed` and calling [`end`] closes it; a menu closed before it is
/// entered never appears.
pub fn show(
    owner: isize,
    (x, y): (i32, i32),
    nodes: Vec<MenuNode>,
    closed: Rc<Cell<bool>>,
    tracking: impl FnOnce() + 'static,
    done: impl FnOnce(io::Result<Option<u32>>) + 'static,
) -> io::Result<()> {
    let window = window()?;
    JOBS.with(|jobs| {
        jobs.borrow_mut().push(Job {
            owner,
            x,
            y,
            nodes,
            closed,
            tracking: Box::new(tracking),
            done: Box::new(done),
        })
    });
    // SAFETY: posts to this thread's own live message-only window.
    if unsafe { PostMessageW(window, WM_SHOW_MENU, 0, 0) } == 0 {
        let error = io::Error::last_os_error();
        JOBS.with(|jobs| jobs.borrow_mut().pop());
        return Err(error);
    }
    Ok(())
}
