//! Window-owned OS-wide key registrations on macOS through Carbon hot keys.
//!
//! Everything runs on GPUI's main thread: registration and release are
//! synchronous Event Manager calls, and the main run loop dispatches presses
//! to a handler that only queues the registration's number. The registry
//! decides delivery, so a press queued for a registration that has since been
//! released is never published.

use crate::channel::EventSink;
use bun_native_macos_surface::hot_keys::{self, HotKey, HotKeyError, HotKeyModifiers, HotKeys};
use bun_native_protocol::{
    ErrorCode, Event, MAX_GLOBAL_SHORTCUTS, RequestId, ShortcutId, ShortcutModifiers, WindowId,
};
use gpui::{App, Task, Window};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

type Failure = (ErrorCode, &'static str);

/// Presses waiting for the UI; a burst beyond it is dropped, as on X11.
const MAX_PRESSES: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Combination {
    key: String,
    modifiers: ShortcutModifiers,
}

struct Registration {
    window: WindowId,
    combination: Combination,
    /// The number the press handler reports for this registration.
    number: u32,
    _hot_key: HotKey,
}

struct Inner {
    registrations: RefCell<BTreeMap<ShortcutId, Registration>>,
    last_shortcut: Cell<u64>,
    last_number: Cell<u32>,
    stopping: Cell<bool>,
    events: EventSink,
    /// Installed with the first registration, removed at shutdown.
    handler: RefCell<Option<HotKeys>>,
}

#[derive(Clone)]
pub(crate) struct Shortcuts(Rc<Inner>);

impl Shortcuts {
    pub(crate) fn new(events: EventSink, _cx: &App) -> Self {
        Self(Rc::new(Inner {
            registrations: RefCell::new(BTreeMap::new()),
            last_shortcut: Cell::new(0),
            last_number: Cell::new(0),
            stopping: Cell::new(false),
            events,
            handler: RefCell::new(None),
        }))
    }

    /// The Carbon Event Manager is part of every macOS session.
    pub(crate) fn available(&self) -> bool {
        true
    }

    pub(crate) fn supports_window(window: &Window) -> bool {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        matches!(
            HasWindowHandle::window_handle(window).map(|handle| handle.as_raw()),
            Ok(RawWindowHandle::AppKit(_))
        )
    }

    pub(crate) fn register(
        &self,
        request: (RequestId, WindowId, ShortcutId),
        key: &str,
        modifiers: ShortcutModifiers,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (id, window, shortcut) = request;
        let combination = check_register(
            self.0.last_shortcut.get(),
            (shortcut, key, modifiers),
            self.0.registrations.borrow().len(),
            self.0
                .registrations
                .borrow()
                .values()
                .map(|registration| &registration.combination),
            self.0.stopping.get(),
        )?;
        let code = hot_keys::key_code(key).map_err(failure)?;
        self.install(cx)?;
        let number = self.0.last_number.get().wrapping_add(1);
        let hot_key = self
            .0
            .handler
            .borrow()
            .as_ref()
            .ok_or((
                ErrorCode::NativeFailure,
                "global shortcut handler is unavailable",
            ))?
            .register(number, code, carbon(modifiers))
            .map_err(failure)?;
        self.0.last_number.set(number);
        self.0.last_shortcut.set(shortcut.get());
        self.0.registrations.borrow_mut().insert(
            shortcut,
            Registration {
                window,
                combination,
                number,
                _hot_key: hot_key,
            },
        );
        self.0.events.send(
            Event::GlobalShortcutRegistered {
                id,
                window_id: window,
                shortcut_id: shortcut,
            },
            cx,
        );
        Ok(())
    }

    fn install(&self, cx: &mut App) -> Result<(), Failure> {
        if self.0.handler.borrow().is_some() {
            return Ok(());
        }
        let (sender, presses) = async_channel::bounded::<u32>(MAX_PRESSES);
        let installed = HotKeys::install(move |number| {
            // Activations are edge notifications; a full queue drops one.
            let _ = sender.try_send(number);
        })
        .map_err(|_| {
            (
                ErrorCode::NativeFailure,
                "cannot install the global shortcut handler",
            )
        })?;
        self.0.handler.replace(Some(installed));
        let this = self.clone();
        cx.spawn(async move |cx| {
            // Ends when the handler, and with it the sender, is removed.
            while let Ok(number) = presses.recv().await {
                cx.update(|cx| this.pressed(number, cx));
            }
        })
        .detach();
        Ok(())
    }

    fn pressed(&self, number: u32, cx: &mut App) {
        let found = self
            .0
            .registrations
            .borrow()
            .iter()
            .find_map(|(shortcut, registration)| {
                (registration.number == number).then_some((*shortcut, registration.window))
            });
        let Some((shortcut, window)) = found else {
            return;
        };
        self.0.events.ui(
            |sequence| Event::GlobalShortcut {
                sequence,
                window_id: window,
                shortcut_id: shortcut,
            },
            cx,
        );
    }

    pub(crate) fn unregister(
        &self,
        id: RequestId,
        window: WindowId,
        shortcut: ShortcutId,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let mut registrations = self.0.registrations.borrow_mut();
        if registrations
            .get(&shortcut)
            .is_none_or(|registration| registration.window != window)
        {
            return Err((
                ErrorCode::InvalidHandle,
                "global shortcut is not registered by this window",
            ));
        }
        // Dropping the registration unregisters the hot key now.
        registrations.remove(&shortcut);
        drop(registrations);
        self.0.events.send(
            Event::GlobalShortcutUnregistered {
                id,
                window_id: window,
                shortcut_id: shortcut,
            },
            cx,
        );
        Ok(())
    }

    /// Owner close revokes delivery and unregisters each hot key now.
    pub(crate) fn close_window(&self, window: WindowId, _cx: &mut App) {
        self.0
            .registrations
            .borrow_mut()
            .retain(|_, registration| registration.window != window);
    }

    /// Unregister every hot key, then remove the handler. Nothing runs on
    /// another thread.
    pub(crate) fn stop(&self, _cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.set(true);
        self.0.registrations.borrow_mut().clear();
        self.0.handler.replace(None);
        None
    }
}

fn carbon(modifiers: ShortcutModifiers) -> HotKeyModifiers {
    HotKeyModifiers {
        command: modifiers.platform,
        shift: modifiers.shift,
        option: modifiers.alt,
        control: modifiers.control,
    }
}

fn failure(error: HotKeyError) -> Failure {
    match error {
        HotKeyError::Conflict => (
            ErrorCode::Conflict,
            "this key combination is held by another application",
        ),
        HotKeyError::KeyUnavailable => (
            ErrorCode::ServiceUnavailable,
            "the current keyboard layout has no key for this global shortcut",
        ),
        HotKeyError::WrongThread | HotKeyError::Failed(_) => (
            ErrorCode::NativeFailure,
            "the OS refused the global shortcut registration",
        ),
    }
}

/// The argument and capacity checks for a new registration, in reply order.
fn check_register<'a>(
    last_shortcut: u64,
    (shortcut, key, modifiers): (ShortcutId, &str, ShortcutModifiers),
    live: usize,
    mut registered: impl Iterator<Item = &'a Combination>,
    stopping: bool,
) -> Result<Combination, Failure> {
    if shortcut.get() <= last_shortcut {
        return Err((
            ErrorCode::InvalidHandle,
            "global shortcut IDs must increase across the session",
        ));
    }
    bun_native_protocol::validate_global_shortcut(key, modifiers).map_err(|_| {
        (
            ErrorCode::InvalidCommand,
            "global shortcut key is outside the supported set",
        )
    })?;
    let combination = Combination {
        key: key.into(),
        modifiers,
    };
    if live >= MAX_GLOBAL_SHORTCUTS {
        return Err((
            ErrorCode::LimitExceeded,
            "global shortcut registration limit exceeded",
        ));
    }
    if registered.any(|existing| *existing == combination) {
        return Err((
            ErrorCode::Conflict,
            "this key combination is already registered by this application",
        ));
    }
    if stopping {
        return Err((
            ErrorCode::Cancelled,
            "global shortcut service is shutting down",
        ));
    }
    Ok(combination)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTROL: ShortcutModifiers = ShortcutModifiers {
        control: true,
        alt: false,
        shift: false,
        platform: false,
    };

    fn combination(key: &str, modifiers: ShortcutModifiers) -> Combination {
        Combination {
            key: key.into(),
            modifiers,
        }
    }

    fn check(
        last: u64,
        (shortcut, key, modifiers): (u64, &str, ShortcutModifiers),
        live: usize,
        registered: &[Combination],
        stopping: bool,
    ) -> Result<Combination, Failure> {
        check_register(
            last,
            (ShortcutId::try_from(shortcut).unwrap(), key, modifiers),
            live,
            registered.iter(),
            stopping,
        )
    }

    #[test]
    fn checks_ids_then_keys_then_limit_then_conflict_then_shutdown() {
        let existing = [combination("a", CONTROL)];
        assert!(check(1, (2, "f12", CONTROL), 1, &existing, false).is_ok());
        let alt = ShortcutModifiers {
            alt: true,
            ..CONTROL
        };
        assert!(check(1, (2, "a", alt), 1, &existing, false).is_ok());
        assert_eq!(
            check(5, (5, "", CONTROL), usize::MAX, &existing, true)
                .unwrap_err()
                .0,
            ErrorCode::InvalidHandle
        );
        for key in ["", "A", "f0", "f13", "space", "aa"] {
            assert_eq!(
                check(0, (1, key, CONTROL), usize::MAX, &existing, true)
                    .unwrap_err()
                    .0,
                ErrorCode::InvalidCommand,
                "{key}"
            );
        }
        let shift_only = ShortcutModifiers {
            shift: true,
            ..Default::default()
        };
        assert_eq!(
            check(0, (1, "a", shift_only), 0, &[], false).unwrap_err().0,
            ErrorCode::InvalidCommand
        );
        assert_eq!(
            check(0, (1, "a", CONTROL), MAX_GLOBAL_SHORTCUTS, &existing, true)
                .unwrap_err()
                .0,
            ErrorCode::LimitExceeded
        );
        assert_eq!(
            check(0, (1, "a", CONTROL), 1, &existing, true)
                .unwrap_err()
                .0,
            ErrorCode::Conflict
        );
        assert_eq!(
            check(0, (1, "b", CONTROL), 1, &existing, true)
                .unwrap_err()
                .0,
            ErrorCode::Cancelled
        );
    }

    #[test]
    fn platform_is_command_and_alt_is_option() {
        let all = ShortcutModifiers {
            control: true,
            alt: true,
            shift: true,
            platform: true,
        };
        assert_eq!(
            carbon(all),
            HotKeyModifiers {
                command: true,
                shift: true,
                option: true,
                control: true,
            }
        );
        assert_eq!(
            carbon(ShortcutModifiers {
                platform: true,
                ..Default::default()
            }),
            HotKeyModifiers {
                command: true,
                ..Default::default()
            }
        );
    }

    #[test]
    fn os_refusals_map_to_protocol_codes() {
        assert_eq!(failure(HotKeyError::Conflict).0, ErrorCode::Conflict);
        assert_eq!(
            failure(HotKeyError::KeyUnavailable).0,
            ErrorCode::ServiceUnavailable
        );
        assert_eq!(
            failure(HotKeyError::Failed(-50)).0,
            ErrorCode::NativeFailure
        );
    }
}
