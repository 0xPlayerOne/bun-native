//! CEF-specific owner-thread operations. IDs only select an existing host-owned window.
use super::{number, reply, STATE};
use cef::{ImplView, ImplWindow, Window};
use serde_json::{json, Value};

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::WindowRecord;

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
