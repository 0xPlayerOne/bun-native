//! Text-only native clipboard operations on the CEF owner thread. No shell fallback.
use super::{captured_ready_scope, number, policy_scope, reply, STATE};
use crate::capability_policy::{
    self, AdapterAvailability, DocumentScope, GateDecision, NativeRequest,
};
use cef::Window;
use serde_json::Value;

pub(super) const SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "windows"));
const MAX_TEXT_BYTES: usize = 8192;

fn checked_text(text: &str) -> Result<(), &'static str> {
    if text.len() > MAX_TEXT_BYTES || text.contains('\0') {
        return Err(
            "INVALID_ARGUMENT: clipboard text requires at most 8192 UTF-8 bytes without NUL",
        );
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn decode_text(units: &[u16]) -> Result<String, &'static str> {
    if units.len() > MAX_TEXT_BYTES {
        return Err("INVALID_ARGUMENT: clipboard text exceeds the UTF-8 limit");
    }
    let mut text = String::with_capacity(units.len());
    for scalar in char::decode_utf16(units.iter().copied()) {
        let scalar = scalar.map_err(|_| "INVALID_ARGUMENT: clipboard text is not valid Unicode")?;
        if scalar == '\0' || text.len() + scalar.len_utf8() > MAX_TEXT_BYTES {
            return Err("INVALID_ARGUMENT: clipboard text exceeds the UTF-8 limit or contains NUL");
        }
        text.push(scalar);
    }
    Ok(text)
}

fn authorize(
    scope: &DocumentScope,
    operation: &NativeRequest,
    availability: AdapterAvailability,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if super::RPC_STOPPED.load(Ordering::SeqCst) || super::QUITTING.load(Ordering::SeqCst) {
        return Err("PERMISSION_DENIED: native application is shutting down".into());
    }
    let grants = STATE.with(|state| {
        let state = state.borrow();
        captured_ready_scope(&state, scope.view, scope)
            .map_err(|_| "PERMISSION_DENIED: clipboard document authority changed")?;
        state
            .policy
            .native_grants(scope)
            .ok_or("PERMISSION_DENIED: clipboard document authority changed")
    })?;
    match capability_policy::authorize_native_grants(&grants, operation, availability) {
        GateDecision::Authorized => Ok(()),
        GateDecision::Denied => {
            Err("PERMISSION_DENIED: clipboard capability scope mismatch".into())
        }
        GateDecision::Unavailable => {
            Err("UNSUPPORTED_CAPABILITY: native text clipboard unavailable on this platform".into())
        }
    }
}
fn perform<T>(
    scope: &DocumentScope,
    operation: &NativeRequest,
    availability: AdapterAvailability,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    authorize(scope, operation, availability)?;
    let result = action()?;
    authorize(scope, operation, availability)?;
    Ok(result)
}

pub(super) fn dispatch(request: u64, operation: &str, args: &Value) -> Result<(), String> {
    let object = args
        .as_object()
        .ok_or("INVALID_ARGUMENT: clipboard arguments must be an object")?;
    let expected_fields = if operation == "clipboard.write" { 3 } else { 2 };
    if object.len() != expected_fields
        || object
            .keys()
            .any(|key| !matches!(key.as_str(), "id" | "scope" | "text"))
        || (operation != "clipboard.write" && object.contains_key("text"))
    {
        return Err("INVALID_ARGUMENT: unexpected clipboard argument".into());
    }
    let id = number(args, "id")?;
    let scope = policy_scope(args)?;
    if id != scope.view {
        return Err("PERMISSION_DENIED: clipboard scope does not match view".into());
    }
    let native_request = match operation {
        "clipboard.read" => NativeRequest::ClipboardRead,
        "clipboard.write" | "clipboard.clear" => NativeRequest::ClipboardWrite,
        #[cfg(feature = "rpc-qualification")]
        "clipboard.qualification.empty" => NativeRequest::ClipboardRead,
        _ => return Err("INVALID_ARGUMENT: unknown clipboard operation".into()),
    };
    let text = if operation == "clipboard.write" {
        let text = args
            .get("text")
            .and_then(Value::as_str)
            .ok_or("INVALID_ARGUMENT: clipboard text must be a string")?;
        checked_text(text)?;
        Some(text)
    } else {
        None
    };
    // Resolve the owning Window before the final gate. No STATE borrow remains
    // while platform APIs can enter an OS nested loop or invoke native callbacks.
    let window = STATE.with(|state| {
        let state = state.borrow();
        let view = state
            .views
            .get(&id)
            .ok_or("PERMISSION_DENIED: clipboard view is closed")?;
        let owner = state
            .windows
            .get(&view.window)
            .ok_or("PERMISSION_DENIED: clipboard owner is closed")?;
        if owner.closing.is_some() {
            return Err("PERMISSION_DENIED: clipboard owner is closing");
        }
        owner
            .window
            .clone()
            .ok_or("PERMISSION_DENIED: clipboard owner is not ready")
    })?;
    let availability = if SUPPORTED {
        AdapterAvailability::Available
    } else {
        AdapterAvailability::Unavailable
    };
    let result = perform(&scope, &native_request, availability, || {
        let check = || authorize(&scope, &native_request, availability);
        if let Some(text) = text {
            platform::write(&window, text, &check)?;
            Ok(Value::Null)
        } else if operation == "clipboard.clear" {
            platform::clear(&window, &check)?;
            Ok(Value::Null)
        } else {
            #[cfg(feature = "rpc-qualification")]
            if operation == "clipboard.qualification.empty" {
                return platform::empty(&window, &check).map(Value::Bool);
            }
            match platform::read(&window, &check)? {
                Some(text) => {
                    checked_text(&text)?;
                    Ok(Value::String(text))
                }
                None => Ok(Value::Null),
            }
        }
    })?;
    // A clipboard operation may reenter the native loop. Never return data or a
    // success receipt to a document whose exact authority has since changed.
    reply(request, result);
    Ok(())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::{NSArray, NSRange, NSString};
    use std::ptr::NonNull;

    pub(super) fn read(
        _window: &Window,
        check: &impl Fn() -> Result<(), String>,
    ) -> Result<Option<String>, String> {
        let pasteboard = NSPasteboard::generalPasteboard();
        let string_type = unsafe { NSPasteboardTypeString };
        // Establish the available type before asking the pasteboard server for data.
        if pasteboard
            .availableTypeFromArray(&NSArray::from_slice(&[string_type]))
            .is_none()
        {
            return Ok(None);
        }
        check()?;
        let Some(text) = pasteboard.stringForType(string_type) else {
            return Ok(None);
        };
        let length = text.length();
        if length > MAX_TEXT_BYTES {
            return Err("INVALID_ARGUMENT: clipboard text exceeds the UTF-8 limit".into());
        }
        let mut units = vec![0_u16; length];
        if length != 0 {
            // The exact NSString UTF-16 length was checked before this bounded allocation.
            unsafe {
                text.getCharacters_range(
                    NonNull::new(units.as_mut_ptr()).unwrap(),
                    NSRange::new(0, length),
                );
            }
        }
        decode_text(&units).map(Some).map_err(str::to_owned)
    }
    pub(super) fn write(
        _window: &Window,
        text: &str,
        check: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        let value = NSString::from_str(text);
        let pasteboard = NSPasteboard::generalPasteboard();
        check()?;
        pasteboard.clearContents();
        // Clearing may reenter native callbacks; do not start a subsequent write
        // after that callback revoked the originally admitted document authority.
        check()?;
        if !pasteboard.setString_forType(&value, unsafe { NSPasteboardTypeString }) {
            return Err("Native clipboard text write failed".into());
        }
        Ok(())
    }
    pub(super) fn clear(
        _window: &Window,
        check: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        let pasteboard = NSPasteboard::generalPasteboard();
        check()?;
        pasteboard.clearContents();
        Ok(())
    }
    #[cfg(feature = "rpc-qualification")]
    pub(super) fn empty(
        _window: &Window,
        check: &impl Fn() -> Result<(), String>,
    ) -> Result<bool, String> {
        // Inspect item metadata only. Apple's API returns nil on failure, which
        // must never be mistaken for permission to overwrite unknown contents.
        let pasteboard = NSPasteboard::generalPasteboard();
        check()?;
        pasteboard
            .pasteboardItems()
            .map(|items| items.count() == 0)
            .ok_or_else(|| "Native clipboard preflight unavailable".into())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use cef::ImplWindow;
    #[cfg(feature = "rpc-qualification")]
    use windows_sys::Win32::{
        Foundation::{GetLastError, SetLastError},
        System::DataExchange::EnumClipboardFormats,
    };
    use windows_sys::Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND},
        System::{
            DataExchange::{
                CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
                OpenClipboard, SetClipboardData,
            },
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
            Ole::CF_UNICODETEXT,
        },
    };
    struct Open;
    impl Drop for Open {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }
    struct Allocation(HGLOBAL);
    impl Drop for Allocation {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    GlobalFree(self.0);
                }
            }
        }
    }
    struct Locked(HGLOBAL);
    impl Drop for Locked {
        fn drop(&mut self) {
            unsafe {
                GlobalUnlock(self.0);
            }
        }
    }
    fn open(window: &Window) -> Result<Open, String> {
        let handle: HWND = window.window_handle().0.cast();
        if handle.is_null() {
            return Err("Native clipboard owner window unavailable".into());
        }
        if unsafe { OpenClipboard(handle) } == 0 {
            return Err("RESOURCE_IN_USE: native clipboard is busy".into());
        }
        Ok(Open)
    }
    pub(super) fn read(
        window: &Window,
        check: &impl Fn() -> Result<(), String>,
    ) -> Result<Option<String>, String> {
        let _open = open(window)?;
        check()?;
        if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT.into()) } == 0 {
            return Ok(None);
        }
        check()?;
        let handle = unsafe { GetClipboardData(CF_UNICODETEXT.into()) };
        if handle.is_null() {
            return Err("Native clipboard text read failed".into());
        }
        let bytes = unsafe { GlobalSize(handle) };
        if bytes < 2 || !bytes.is_multiple_of(2) {
            return Err("INVALID_ARGUMENT: malformed clipboard Unicode data".into());
        }
        let pointer = unsafe { GlobalLock(handle) };
        if pointer.is_null() {
            return Err("Native clipboard memory unavailable".into());
        }
        let _locked = Locked(handle);
        // Never scan/copy an unbounded OS allocation. Large trailing storage does
        // not matter when its required terminator occurs inside this text limit.
        let units = unsafe {
            std::slice::from_raw_parts(pointer.cast::<u16>(), (bytes / 2).min(MAX_TEXT_BYTES + 1))
        };
        let end = units
            .iter()
            .position(|unit| *unit == 0)
            .ok_or("INVALID_ARGUMENT: clipboard text is unterminated or exceeds the UTF-8 limit")?;
        decode_text(&units[..end]).map(Some).map_err(str::to_owned)
    }
    pub(super) fn write(
        window: &Window,
        text: &str,
        check: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let mut allocation = Allocation(unsafe { GlobalAlloc(GMEM_MOVEABLE, units.len() * 2) });
        if allocation.0.is_null() {
            return Err("Native clipboard allocation failed".into());
        }
        let pointer = unsafe { GlobalLock(allocation.0) };
        if pointer.is_null() {
            return Err("Native clipboard memory unavailable".into());
        }
        {
            let _locked = Locked(allocation.0);
            unsafe {
                std::ptr::copy_nonoverlapping(units.as_ptr(), pointer.cast::<u16>(), units.len());
            }
        }
        let _open = open(window)?;
        check()?;
        if unsafe { EmptyClipboard() } == 0 {
            return Err("Native clipboard could not prepare text write".into());
        }
        check()?;
        if unsafe { SetClipboardData(CF_UNICODETEXT.into(), allocation.0 as HANDLE) }.is_null() {
            return Err("Native clipboard text write failed".into());
        }
        // SetClipboardData transferred the allocation to the OS. Neither this
        // adapter nor its document/generation owns it after this point.
        allocation.0 = std::ptr::null_mut();
        Ok(())
    }
    pub(super) fn clear(
        window: &Window,
        check: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        let _open = open(window)?;
        check()?;
        if unsafe { EmptyClipboard() } == 0 {
            return Err("Native clipboard clear failed".into());
        }
        Ok(())
    }
    #[cfg(feature = "rpc-qualification")]
    pub(super) fn empty(
        window: &Window,
        check: &impl Fn() -> Result<(), String>,
    ) -> Result<bool, String> {
        let _open = open(window)?;
        check()?;
        unsafe { SetLastError(0) };
        if unsafe { EnumClipboardFormats(0) } != 0 {
            return Ok(false);
        }
        if unsafe { GetLastError() } != 0 {
            return Err("Native clipboard preflight unavailable".into());
        }
        Ok(true)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;
    pub(super) fn read(
        _window: &Window,
        _check: &impl Fn() -> Result<(), String>,
    ) -> Result<Option<String>, String> {
        Err("UNSUPPORTED_CAPABILITY: native text clipboard unavailable on this platform".into())
    }
    pub(super) fn write(
        _window: &Window,
        _text: &str,
        _check: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        Err("UNSUPPORTED_CAPABILITY: native text clipboard unavailable on this platform".into())
    }
    pub(super) fn clear(
        _window: &Window,
        _check: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        Err("UNSUPPORTED_CAPABILITY: native text clipboard unavailable on this platform".into())
    }
    #[cfg(feature = "rpc-qualification")]
    pub(super) fn empty(
        _window: &Window,
        _check: &impl Fn() -> Result<(), String>,
    ) -> Result<bool, String> {
        Err("UNSUPPORTED_CAPABILITY: native text clipboard unavailable on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipboard_text_bounds_are_unicode_and_byte_bounds_before_os_access() {
        assert!(checked_text("").is_ok());
        assert!(checked_text(&"x".repeat(MAX_TEXT_BYTES)).is_ok());
        assert!(checked_text(&"x".repeat(MAX_TEXT_BYTES + 1)).is_err());
        assert!(checked_text("hello\0world").is_err());
        assert_eq!(decode_text(&[0x41, 0xd83d, 0xdc19]).unwrap(), "A🐙");
        assert!(decode_text(&[0xd800]).is_err());
        assert!(decode_text(&[0xdc00]).is_err());
        assert!(decode_text(&[0]).is_err());
        assert!(decode_text(&vec![0x0800; MAX_TEXT_BYTES / 3 + 1]).is_err());
        assert!(decode_text(&vec![0x41; MAX_TEXT_BYTES + 1]).is_err());
    }
    #[test]
    fn exact_native_scope_is_checked_before_execution_and_before_returning_read_data() {
        let (state, scope) = super::super::tests::state_with_view(7, 11);
        STATE.with(|slot| *slot.borrow_mut() = state);
        let calls = std::cell::Cell::new(0);
        let action = || {
            calls.set(calls.get() + 1);
            Ok("bounded fixture".to_owned())
        };
        assert!(perform(
            &scope,
            &NativeRequest::ClipboardRead,
            AdapterAvailability::Available,
            action
        )
        .is_ok());
        assert_eq!(calls.get(), 1);
        assert!(perform(
            &scope,
            &NativeRequest::ClipboardWrite,
            AdapterAvailability::Available,
            action
        )
        .unwrap_err()
        .starts_with("PERMISSION_DENIED:"));
        assert!(perform(
            &scope,
            &NativeRequest::ClipboardRead,
            AdapterAvailability::Unavailable,
            action
        )
        .unwrap_err()
        .starts_with("UNSUPPORTED_CAPABILITY:"));
        let mut stale = scope.clone();
        stale.generation += 1;
        assert!(perform(
            &stale,
            &NativeRequest::ClipboardRead,
            AdapterAvailability::Available,
            action
        )
        .is_err());
        assert_eq!(calls.get(), 1);
        assert!(perform(
            &scope,
            &NativeRequest::ClipboardRead,
            AdapterAvailability::Available,
            || {
                STATE.with(|slot| slot.borrow_mut().policy.close_view(scope.view));
                Ok("must not escape the revoked scope")
            }
        )
        .unwrap_err()
        .starts_with("PERMISSION_DENIED:"));
        STATE.with(|slot| *slot.borrow_mut() = Default::default());
    }
}
