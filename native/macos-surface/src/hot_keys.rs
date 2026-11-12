//! OS-wide hot keys through the Carbon Event Manager.
//!
//! `RegisterEventHotKey` is the macOS mechanism for a key combination that
//! reaches an application while another one is frontmost. It needs no
//! Accessibility or Input Monitoring permission and sees only its own
//! combinations, never other typing. Each registration is exclusive
//! (`kEventHotKeyExclusive`): a combination another process already holds
//! exclusively is refused with `eventHotKeyExistsErr`, reported as
//! [`HotKeyError::Conflict`], and never shared.
//!
//! A key is resolved to its virtual key code through the current keyboard
//! layout (`UCKeyTranslate`), so `a` names the key that types `a`, not the
//! ANSI position. Presses are dispatched by the main run loop to a handler on
//! the application's event dispatcher target, which only forwards the
//! registration's number. Everything here runs on the main thread.
#![allow(unsafe_code)] // Reviewed Carbon Event Manager and Text Input Source calls.

use crate::{SurfaceError, main_thread};
use std::cell::RefCell;
use std::ffi::c_void;
use std::fmt;
use std::rc::Rc;

type OsStatus = i32;
type Opaque = *mut c_void;

#[repr(C)]
struct EventTypeSpec {
    event_class: u32,
    event_kind: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct EventHotKeyId {
    signature: u32,
    id: u32,
}

type EventHandler = unsafe extern "C" fn(Opaque, Opaque, Opaque) -> OsStatus;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn GetEventDispatcherTarget() -> Opaque;
    fn InstallEventHandler(
        target: Opaque,
        handler: EventHandler,
        type_count: usize,
        types: *const EventTypeSpec,
        user_data: Opaque,
        handler_ref: *mut Opaque,
    ) -> OsStatus;
    fn RemoveEventHandler(handler_ref: Opaque) -> OsStatus;
    fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        id: EventHotKeyId,
        target: Opaque,
        options: u32,
        hot_key: *mut Opaque,
    ) -> OsStatus;
    fn UnregisterEventHotKey(hot_key: Opaque) -> OsStatus;
    fn GetEventParameter(
        event: Opaque,
        name: u32,
        desired_type: u32,
        actual_type: *mut u32,
        size: usize,
        actual_size: *mut usize,
        data: *mut c_void,
    ) -> OsStatus;
    fn TISCopyCurrentKeyboardLayoutInputSource() -> Opaque;
    fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> Opaque;
    fn TISGetInputSourceProperty(source: Opaque, key: *const c_void) -> *const c_void;
    static kTISPropertyUnicodeKeyLayoutData: *const c_void;
    fn LMGetKbdType() -> u8;
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    #[allow(clippy::too_many_arguments)] // The C signature.
    fn UCKeyTranslate(
        layout: *const c_void,
        virtual_key: u16,
        action: u16,
        modifier_state: u32,
        keyboard_type: u32,
        options: u32,
        dead_key_state: *mut u32,
        max_length: usize,
        actual_length: *mut usize,
        characters: *mut u16,
    ) -> OsStatus;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
    fn CFRelease(object: *const c_void);
}

const fn four(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

const NO_ERR: OsStatus = 0;
const EVENT_NOT_HANDLED: OsStatus = -9874;
const HOT_KEY_EXISTS: OsStatus = -9878;
const EVENT_CLASS_KEYBOARD: u32 = four(b"keyb");
const EVENT_HOT_KEY_PRESSED: u32 = 5;
const PARAM_DIRECT_OBJECT: u32 = four(b"----");
const TYPE_EVENT_HOT_KEY_ID: u32 = four(b"hkid");
const HOT_KEY_EXCLUSIVE: u32 = 1;
/// Identifies this boundary's registrations among the process's hot keys.
const SIGNATURE: u32 = four(b"BnHk");
const KEY_ACTION_DISPLAY: u16 = 3;
const NO_DEAD_KEYS: u32 = 1;

/// Carbon modifier masks (`cmdKey`, `shiftKey`, `optionKey`, `controlKey`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HotKeyModifiers {
    pub command: bool,
    pub shift: bool,
    pub option: bool,
    pub control: bool,
}

impl HotKeyModifiers {
    fn mask(self) -> u32 {
        (u32::from(self.command) << 8)
            | (u32::from(self.shift) << 9)
            | (u32::from(self.option) << 11)
            | (u32::from(self.control) << 12)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HotKeyError {
    WrongThread,
    /// Another process holds the combination exclusively.
    Conflict,
    /// The current keyboard layout has no key for this name.
    KeyUnavailable,
    /// The Event Manager refused with this status.
    Failed(i32),
}

impl fmt::Display for HotKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongThread => f.write_str("hot keys require the main thread"),
            Self::Conflict => f.write_str("another process holds this hot key"),
            Self::KeyUnavailable => f.write_str("the keyboard layout has no key for this name"),
            Self::Failed(status) => write!(f, "the Carbon Event Manager failed with {status}"),
        }
    }
}
impl std::error::Error for HotKeyError {}

impl From<SurfaceError> for HotKeyError {
    fn from(_: SurfaceError) -> Self {
        Self::WrongThread
    }
}

/// The virtual key code of a function key `f1`-`f12`.
pub fn function_key(name: &str) -> Option<u16> {
    Some(match name {
        "f1" => 0x7a,
        "f2" => 0x78,
        "f3" => 0x63,
        "f4" => 0x76,
        "f5" => 0x60,
        "f6" => 0x61,
        "f7" => 0x62,
        "f8" => 0x64,
        "f9" => 0x65,
        "f10" => 0x6d,
        "f11" => 0x67,
        "f12" => 0x6f,
        _ => return None,
    })
}

/// The main-block keys (`kVK_ANSI_A` 0x00 through `kVK_ANSI_Grave` 0x32,
/// including the ISO section key). Keypad digits are never chosen.
const MAIN_BLOCK: std::ops::RangeInclusive<u16> = 0x00..=0x32;

/// The virtual key code that types `character` (unshifted) in the current
/// keyboard layout, or a function key's fixed code.
pub fn key_code(name: &str) -> Result<u16, HotKeyError> {
    let _main_thread = main_thread()?;
    if let Some(code) = function_key(name) {
        return Ok(code);
    }
    let mut characters = name.chars();
    let (Some(character), None) = (characters.next(), characters.next()) else {
        return Err(HotKeyError::KeyUnavailable);
    };
    let layout = Layout::current().ok_or(HotKeyError::KeyUnavailable)?;
    MAIN_BLOCK
        .into_iter()
        .find(|code| layout.translate(*code) == Some(character))
        .ok_or(HotKeyError::KeyUnavailable)
}

/// A retained input source and its Unicode key layout data.
struct Layout {
    source: Opaque,
    data: *const u8,
}

impl Layout {
    fn current() -> Option<Self> {
        // SAFETY: TIS copy functions return a retained source or null; the
        // property is borrowed from that source, which this value keeps
        // retained until drop. The key static is a framework constant.
        unsafe {
            for copy in [
                TISCopyCurrentKeyboardLayoutInputSource as unsafe extern "C" fn() -> Opaque,
                TISCopyCurrentASCIICapableKeyboardLayoutInputSource,
            ] {
                let source = copy();
                if source.is_null() {
                    continue;
                }
                let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
                if property.is_null() {
                    CFRelease(source);
                    continue;
                }
                let data = CFDataGetBytePtr(property);
                if data.is_null() {
                    CFRelease(source);
                    continue;
                }
                return Some(Self { source, data });
            }
        }
        None
    }

    /// The one character this key types with no modifiers and no dead keys.
    fn translate(&self, code: u16) -> Option<char> {
        let mut dead = 0_u32;
        let mut length = 0_usize;
        let mut buffer = [0_u16; 4];
        // SAFETY: `data` points into the retained layout's CFData; the output
        // buffer and its length are local and correctly sized.
        let status = unsafe {
            UCKeyTranslate(
                self.data.cast(),
                code,
                KEY_ACTION_DISPLAY,
                0,
                u32::from(LMGetKbdType()),
                NO_DEAD_KEYS,
                &mut dead,
                buffer.len(),
                &mut length,
                buffer.as_mut_ptr(),
            )
        };
        if status != NO_ERR || length != 1 {
            return None;
        }
        char::from_u32(u32::from(buffer[0]))
    }
}

impl Drop for Layout {
    fn drop(&mut self) {
        // SAFETY: `source` was returned retained by a TIS copy function.
        unsafe { CFRelease(self.source) };
    }
}

type Pressed = Rc<dyn Fn(u32)>;

thread_local! {
    /// The installed handler's callback. Main thread only, like the handler.
    static PRESSED: RefCell<Option<Pressed>> = const { RefCell::new(None) };
}

unsafe extern "C" fn handle(_call: Opaque, event: Opaque, _user: Opaque) -> OsStatus {
    let mut id = EventHotKeyId::default();
    // SAFETY: Carbon passes a live hot-key event; the output is a local
    // EventHotKeyID of exactly the requested size.
    let status = unsafe {
        GetEventParameter(
            event,
            PARAM_DIRECT_OBJECT,
            TYPE_EVENT_HOT_KEY_ID,
            std::ptr::null_mut(),
            size_of::<EventHotKeyId>(),
            std::ptr::null_mut(),
            (&raw mut id).cast(),
        )
    };
    if status != NO_ERR || id.signature != SIGNATURE {
        return EVENT_NOT_HANDLED;
    }
    // Clone out first: the callback may register or release hot keys.
    let pressed = PRESSED.with(|pressed| pressed.try_borrow().ok().and_then(|p| p.clone()));
    match pressed {
        Some(pressed) => {
            pressed(id.id);
            NO_ERR
        }
        None => EVENT_NOT_HANDLED,
    }
}

/// The installed press handler. Dropping it removes the handler; every
/// [`HotKey`] should be dropped first.
pub struct HotKeys {
    handler: Opaque,
}

impl HotKeys {
    /// Install the handler. `pressed` receives the number a [`HotKey`] was
    /// registered with, on the main thread.
    pub fn install(pressed: impl Fn(u32) + 'static) -> Result<Self, HotKeyError> {
        let _main_thread = main_thread()?;
        if PRESSED.with(|current| current.borrow().is_some()) {
            return Err(HotKeyError::Failed(EVENT_NOT_HANDLED));
        }
        let spec = EventTypeSpec {
            event_class: EVENT_CLASS_KEYBOARD,
            event_kind: EVENT_HOT_KEY_PRESSED,
        };
        let mut handler = std::ptr::null_mut();
        // SAFETY: a static handler function, one local type spec, no user
        // data, and an out pointer to a local.
        let status = unsafe {
            InstallEventHandler(
                GetEventDispatcherTarget(),
                handle,
                1,
                &spec,
                std::ptr::null_mut(),
                &mut handler,
            )
        };
        if status != NO_ERR {
            return Err(HotKeyError::Failed(status));
        }
        PRESSED.with(|current| *current.borrow_mut() = Some(Rc::new(pressed)));
        Ok(Self { handler })
    }

    /// Register `code` with `modifiers` exclusively, reporting presses as
    /// `number`.
    pub fn register(
        &self,
        number: u32,
        code: u16,
        modifiers: HotKeyModifiers,
    ) -> Result<HotKey, HotKeyError> {
        let _main_thread = main_thread()?;
        let mut hot_key = std::ptr::null_mut();
        // SAFETY: plain values and an out pointer to a local.
        let status = unsafe {
            RegisterEventHotKey(
                u32::from(code),
                modifiers.mask(),
                EventHotKeyId {
                    signature: SIGNATURE,
                    id: number,
                },
                GetEventDispatcherTarget(),
                HOT_KEY_EXCLUSIVE,
                &mut hot_key,
            )
        };
        match status {
            NO_ERR if !hot_key.is_null() => Ok(HotKey(hot_key)),
            HOT_KEY_EXISTS => Err(HotKeyError::Conflict),
            status => Err(HotKeyError::Failed(status)),
        }
    }
}

impl Drop for HotKeys {
    fn drop(&mut self) {
        PRESSED.with(|current| current.borrow_mut().take());
        // SAFETY: the handler reference InstallEventHandler returned.
        unsafe { RemoveEventHandler(self.handler) };
    }
}

/// One registered combination. Dropping it unregisters it; no press for it
/// is dispatched afterwards.
pub struct HotKey(Opaque);

impl Drop for HotKey {
    fn drop(&mut self) {
        // SAFETY: the reference RegisterEventHotKey returned, released once.
        unsafe { UnregisterEventHotKey(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifiers_map_to_carbon_masks() {
        assert_eq!(HotKeyModifiers::default().mask(), 0);
        let all = HotKeyModifiers {
            command: true,
            shift: true,
            option: true,
            control: true,
        };
        assert_eq!(all.mask(), 0x0100 | 0x0200 | 0x0800 | 0x1000);
        assert_eq!(
            HotKeyModifiers {
                option: true,
                ..Default::default()
            }
            .mask(),
            0x0800
        );
    }

    #[test]
    fn function_keys_have_fixed_codes_and_nothing_else_does() {
        let codes: Vec<u16> = (1..=12)
            .map(|n| function_key(&format!("f{n}")).unwrap())
            .collect();
        let mut unique = codes.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), 12);
        for name in ["f0", "f13", "F1", "a", ""] {
            assert_eq!(function_key(name), None, "{name}");
        }
    }

    #[test]
    fn four_character_codes_are_big_endian() {
        assert_eq!(EVENT_CLASS_KEYBOARD, 0x6b65_7962);
        assert_eq!(TYPE_EVENT_HOT_KEY_ID, 0x686b_6964);
    }

    #[test]
    fn workers_cannot_register_hot_keys() {
        std::thread::spawn(|| {
            assert_eq!(key_code("a").err(), Some(HotKeyError::WrongThread));
            assert_eq!(
                HotKeys::install(|_| {}).err(),
                Some(HotKeyError::WrongThread)
            );
        })
        .join()
        .unwrap();
    }
}
