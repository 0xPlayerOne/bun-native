//! CEF-specific owner-thread operations. IDs only select an existing host-owned window.
use super::{number, reply, STATE};
use cef::{BoxLayoutSettings, ImplView, ImplWindow, Window};
use serde_json::{json, Value};

/// Vertical host layout; per-view main-axis flex is assigned at attachment.
pub(super) fn browser_layout_settings() -> BoxLayoutSettings {
    BoxLayoutSettings {
        horizontal: 0,
        // A vertical layout's cross axis is width. START uses the browser's
        // preferred width, which can become zero while its Windows host is
        // minimized. Stretch follows the real parent width after restoration.
        cross_axis_alignment: cef::AxisAlignment::STRETCH,
        ..Default::default()
    }
}

pub(super) fn live(id: u64) -> Result<Window, &'static str> {
    STATE.with(|state| {
        let state = state.borrow();
        let record = state.windows.get(&id).ok_or("INVALID_HANDLE: window")?;
        if record.closing.is_some() {
            return Err("Window is closing");
        }
        record.window.clone().ok_or("Window not ready")
    })
}

fn read(window: &Window) -> Result<Value, &'static str> {
    if window.is_valid() == 0 || window.is_closed() != 0 {
        return Err("INVALID_HANDLE: closed native window");
    }
    Ok(json!({
        "visible": window.is_visible() != 0,
        "active": window.is_active() != 0,
        "minimized": window.is_minimized() != 0,
        "maximized": window.is_maximized() != 0,
        "fullscreen": window.is_fullscreen() != 0,
    }))
}

pub(super) fn dispatch(request: u64, operation: &str, args: &Value) -> Result<(), String> {
    let id = number(args, "id")?;
    let window = live(id)?;
    read(&window)?;
    match operation {
        "window.state" => (),
        "window.minimize" => window.minimize(),
        "window.restore" => window.restore(),
        _ => return Err("Unknown window state operation".into()),
    }
    // CEF calls may reenter the delegate. Revalidate ownership after the action.
    let window = live(id)?;
    reply(request, read(&window)?);
    Ok(())
}

/// Read-only contributor diagnostics. Never changes visibility, activation,
/// page lifecycle, scheduling, native geometry or the qualification decision.
#[cfg(feature = "rpc-qualification")]
pub(super) fn qualification(request: u64, args: &Value) -> Result<(), String> {
    use cef::{CefString, ImplBrowser, ImplFrame};
    let id = number(args, "id")?;
    let window = live(id)?;
    let window_state = read(&window)?;
    let views = STATE.with(|state| {
        let state = state.borrow();
        state
            .views
            .values()
            .filter(|view| view.window == id && view.close.is_none())
            .take(9)
            .filter_map(|view| Some((view.view.clone()?, view.browser.clone()?)))
            .collect::<Vec<_>>()
    });
    if views.len() != 1 {
        return Err("Visibility diagnostics require one ready fixture view".into());
    }
    let (view, browser) = &views[0];
    let frame = browser
        .main_frame()
        .ok_or("Visibility fixture frame unavailable")?;
    if CefString::from(&frame.url()).to_string() != "app://ui/index.html" {
        return Err("Visibility diagnostics require the packaged fixture".into());
    }
    let bounds = view.bounds();
    #[cfg(windows)]
    let platform = windows_snapshot(window.window_handle().0.cast())?;
    #[cfg(not(windows))]
    let platform = json!({"available":false});
    let result = json!({"window":window_state, "windowDrawn":window.is_drawn()!=0,
        "viewVisible":view.is_visible()!=0, "viewDrawn":view.is_drawn()!=0,
        "viewFocus":view.has_focus()!=0, "viewWidth":bounds.width, "viewHeight":bounds.height,
        "platform":platform});
    // Fixed read-only expression, not caller-provided code or a synthetic event.
    frame.execute_java_script(Some(&CefString::from(
        "console.log('BUNLY_WINDOW_SNAPSHOT:'+JSON.stringify({visibility:document.visibilityState,focus:document.hasFocus(),width:innerWidth,height:innerHeight}))")),
        Some(&CefString::from("app://ui/index.html")), 1);
    reply(request, result);
    Ok(())
}

#[cfg(all(feature = "rpc-qualification", windows))]
fn windows_snapshot(hwnd: windows_sys::Win32::Foundation::HWND) -> Result<Value, String> {
    use windows_sys::Win32::{
        Foundation::{HANDLE, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
        System::{
            StationsAndDesktops::{
                CloseDesktop, GetThreadDesktop, GetUserObjectInformationW, OpenInputDesktop,
                DESKTOP_READOBJECTS, UOI_NAME,
            },
            Threading::{GetCurrentProcessId, GetCurrentThreadId},
        },
        UI::WindowsAndMessaging::{
            GetClientRect, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic,
            IsWindow, IsWindowVisible,
        },
    };
    fn desktop_name(handle: HANDLE) -> Option<Vec<u16>> {
        let mut buffer = [0_u16; 256];
        let mut needed = 0_u32;
        let ok = unsafe {
            GetUserObjectInformationW(
                handle,
                UOI_NAME,
                buffer.as_mut_ptr().cast(),
                std::mem::size_of_val(&buffer) as u32,
                &mut needed,
            )
        };
        if ok == 0
            || needed < 2
            || needed as usize > std::mem::size_of_val(&buffer)
            || !needed.is_multiple_of(2)
        {
            return None;
        }
        Some(buffer[..needed as usize / 2].to_vec())
    }
    if unsafe { IsWindow(hwnd) } == 0 {
        return Err("Owned native visibility handle unavailable".into());
    }
    let mut outer: RECT = unsafe { std::mem::zeroed() };
    let mut client: RECT = unsafe { std::mem::zeroed() };
    if unsafe { GetWindowRect(hwnd, &mut outer) } == 0
        || unsafe { GetClientRect(hwnd, &mut client) } == 0
    {
        return Err("Owned native visibility geometry unavailable".into());
    }
    let foreground = unsafe { GetForegroundWindow() };
    let mut foreground_process = 0;
    let foreground_thread = if foreground.is_null() {
        0
    } else {
        unsafe { GetWindowThreadProcessId(foreground, &mut foreground_process) }
    };
    let thread_id = unsafe { GetCurrentThreadId() };
    let input = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
    let same_desktop = if input.is_null() {
        None
    } else {
        let a = desktop_name(input.cast());
        let b = desktop_name(unsafe { GetThreadDesktop(thread_id) }.cast());
        let result = a.zip(b).map(|(a, b)| a == b);
        unsafe { CloseDesktop(input) };
        result
    };
    let mut cloaked = 0_u32;
    let cloak_result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            std::mem::size_of_val(&cloaked) as u32,
        )
    };
    Ok(
        json!({"available":true, "visible":unsafe {IsWindowVisible(hwnd)}!=0,
        "minimized":unsafe {IsIconic(hwnd)}!=0, "foregroundPresent":!foreground.is_null(),
        "foregroundMatches":foreground==hwnd,
        "foregroundSameProcess":foreground_process==unsafe {GetCurrentProcessId()},
        "foregroundSameThread":foreground_thread==thread_id, "inputDesktopMatches":same_desktop,
        "cloaked":if cloak_result >= 0 {Some(cloaked)} else {None},
        "outerRect":[outer.left,outer.top,outer.right,outer.bottom],
        "clientWidth":client.right-client.left,"clientHeight":client.bottom-client.top}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::WindowRecord;

    #[test]
    fn browser_layout_stretches_cross_axis_instead_of_reusing_minimized_preferred_width() {
        let settings = browser_layout_settings();
        assert_eq!(settings.horizontal, 0);
        assert_eq!(settings.cross_axis_alignment, cef::AxisAlignment::STRETCH);
        assert_eq!(settings.default_flex, 0); // Explicit per-view flex remains authoritative.
        assert_eq!(settings.minimum_cross_axis_size, 0);
        assert_eq!(settings.between_child_spacing, 0);
    }

    #[test]
    fn missing_unready_and_closing_windows_never_reach_cef() {
        assert!(matches!(live(9), Err("INVALID_HANDLE: window")));
        STATE.with(|state| {
            state.borrow_mut().windows.insert(
                9,
                WindowRecord {
                    window: None,
                    request: 1,
                    closing: None,
                },
            );
        });
        assert!(matches!(live(9), Err("Window not ready")));
        STATE.with(|state| state.borrow_mut().windows.get_mut(&9).unwrap().closing = Some(2));
        assert!(matches!(live(9), Err("Window is closing")));
        STATE.with(|state| state.borrow_mut().windows.remove(&9));
        assert!(matches!(live(9), Err("INVALID_HANDLE: window")));
    }
}
