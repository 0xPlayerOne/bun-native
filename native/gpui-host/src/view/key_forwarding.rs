//! Keys for screen readers on Wayland.
//!
//! On X11 the AT-SPI registry reads every key from the X server itself. A
//! Wayland compositor gives no client the keys of another, so libatspi's
//! legacy key device (what Orca uses when `WAYLAND_DISPLAY` is set) hears
//! only the keys an application forwards to the registry's
//! `DeviceEventController`, as GTK 3's ATK bridge does. AccessKit forwards
//! none, so the host forwards each key it receives while assistive
//! technology is enabled.
//!
//! Like GTK, the host waits (within [`TIMEOUT`]) for the registry to deliver
//! each key before the application handles it: a screen reader decides what
//! a caret move means from the key that caused it, and AccessKit's caret
//! event would otherwise reach it first. A key the screen reader consumes as
//! one of its own commands still reaches the application. GPUI reports
//! neither the hardware keycode nor whether a key came from the keypad
//! (`gpui_linux` `keystroke_from_xkb` maps `KP_Enter` to `enter`), so
//! keycodes come from the US layout and keypad keys are sent as their main
//! keyboard equivalents.

use gpui::{App, Global, Keystroke};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};
use xkbcommon::xkb;

/// Each forward is bounded; connecting runs off the key path.
const TIMEOUT: Duration = Duration::from_millis(250);
/// How often a disabled accessibility bus is asked again.
const RECHECK: Duration = Duration::from_secs(1);

const KEY_PRESSED: u32 = 0;
const KEY_RELEASED: u32 = 1;
// X modifier bits, which AT-SPI's DeviceEvent carries.
const SHIFT: i16 = 1 << 0;
const CONTROL: i16 = 1 << 2;
const ALT: i16 = 1 << 3;
const SUPER: i16 = 1 << 6;

/// One AT-SPI `DeviceEvent`. The registry reads `(uinnisb)`, 16-bit keycode
/// and modifiers, as libatspi and GTK's ATK bridge send it, although its
/// introspection data declares `(uiuuisb)`.
type DeviceEvent = (u32, i32, i16, i16, i32, String, bool);

#[derive(Default)]
struct Bus {
    connection: Option<zbus::Connection>,
    connecting: bool,
    checked: Option<Instant>,
}

struct Forwarder {
    bus: Rc<RefCell<Bus>>,
    started: Instant,
    keycodes: HashMap<u32, u32>,
}

impl Global for Forwarder {}

/// Start connecting when a window opens on Wayland, so the first key is
/// already forwarded.
pub(super) fn start(cx: &mut App) {
    if crate::services::wayland(cx) {
        forwarder(cx);
    }
}

fn forwarder(cx: &mut App) -> Rc<RefCell<Bus>> {
    if !cx.has_global::<Forwarder>() {
        cx.set_global(Forwarder {
            bus: Rc::default(),
            started: Instant::now(),
            keycodes: us_keycodes(),
        });
    }
    let bus = cx.global::<Forwarder>().bus.clone();
    let stale = {
        let state = bus.borrow();
        state.connection.is_none()
            && !state.connecting
            && state.checked.is_none_or(|at| at.elapsed() >= RECHECK)
    };
    if stale {
        {
            let mut state = bus.borrow_mut();
            state.connecting = true;
            state.checked = Some(Instant::now());
        }
        let shared = bus.clone();
        cx.spawn(async move |cx| {
            let timer = cx.background_executor().timer(TIMEOUT * 4);
            let connection = futures_lite::future::or(connect(), async move {
                timer.await;
                None
            })
            .await;
            let mut state = shared.borrow_mut();
            state.connection = connection;
            state.connecting = false;
        })
        .detach();
    }
    bus
}

/// Forward one key to the AT-SPI registry when the window is on Wayland.
pub(super) fn forward(key: &Keystroke, down: bool, cx: &mut App) {
    if !crate::services::wayland(cx) {
        return;
    }
    let bus = forwarder(cx);
    let Some(connection) = bus.borrow().connection.clone() else {
        return;
    };
    let forwarder = cx.global::<Forwarder>();
    let Some((keysym, text)) = keysym(key) else {
        return;
    };
    let keycode = forwarder.keycodes.get(&keysym.raw()).copied().unwrap_or(0) as i16;
    let modifiers = [
        (key.modifiers.shift, SHIFT),
        (key.modifiers.control, CONTROL),
        (key.modifiers.alt, ALT),
        (key.modifiers.platform, SUPER),
    ]
    .into_iter()
    .filter_map(|(held, bit)| held.then_some(bit))
    .sum();
    let (string, is_text) = match text {
        Some(text) => (text, true),
        None => (xkb::keysym_get_name(keysym), false),
    };
    let timestamp = forwarder.started.elapsed().as_millis() as i32;
    let event: DeviceEvent = (
        if down { KEY_PRESSED } else { KEY_RELEASED },
        keysym.raw() as i32,
        keycode,
        modifiers,
        timestamp,
        string,
        is_text,
    );
    // zbus reads its socket on its own thread, so the UI thread can wait for
    // the reply; the connection's method timeout bounds the wait.
    let reply = futures_lite::future::block_on(connection.call_method(
        Some("org.a11y.atspi.Registry"),
        "/org/a11y/atspi/registry/deviceeventcontroller",
        Some("org.a11y.atspi.DeviceEventController"),
        "NotifyListenersSync",
        &(event,),
    ));
    if reply.is_err() {
        // The registry went away or is stuck; ask again on a later key.
        bus.borrow_mut().connection = None;
    }
}

/// The keysym of a GPUI keystroke and the text it types, if any.
fn keysym(key: &Keystroke) -> Option<(xkb::Keysym, Option<String>)> {
    let named = match key.key.as_str() {
        "enter" => Some("Return"),
        "pageup" => Some("Prior"),
        "pagedown" => Some("Next"),
        "tab" if key.modifiers.shift => Some("ISO_Left_Tab"),
        "tab" => Some("Tab"),
        "backspace" => Some("BackSpace"),
        "delete" => Some("Delete"),
        "escape" => Some("Escape"),
        "left" => Some("Left"),
        "right" => Some("Right"),
        "up" => Some("Up"),
        "down" => Some("Down"),
        "home" => Some("Home"),
        "end" => Some("End"),
        "insert" => Some("Insert"),
        _ => None,
    };
    if let Some(name) = named {
        return Some((xkb::keysym_from_name(name, xkb::KEYSYM_NO_FLAGS), None));
    }
    if let Some(text) = key.key_char.as_ref().filter(|text| !text.is_empty())
        && !key.modifiers.control
        && !key.modifiers.platform
    {
        let mut chars = text.chars();
        if let (Some(character), None) = (chars.next(), chars.next()) {
            let keysym = xkb::utf32_to_keysym(character as u32);
            if keysym.raw() != 0 {
                return Some((keysym, Some(text.clone())));
            }
        }
    }
    // Function keys and letters with Control are named by GPUI.
    let name = match key.key.as_str() {
        "space" => "space".to_owned(),
        name if name.len() > 1 && name.starts_with('f') => name.to_uppercase(),
        name => name.to_owned(),
    };
    let keysym = xkb::keysym_from_name(&name, xkb::KEYSYM_NO_FLAGS);
    (keysym.raw() != 0).then_some((keysym, None))
}

/// Keysym to keycode on the US layout, the layout of the session the
/// screen reader reads its own key bindings from.
fn us_keycodes() -> HashMap<u32, u32> {
    let mut keycodes = HashMap::new();
    let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
    let Some(keymap) = xkb::Keymap::new_from_names(
        &context,
        "evdev",
        "pc105",
        "us",
        "",
        None,
        xkb::KEYMAP_COMPILE_NO_FLAGS,
    ) else {
        return keycodes;
    };
    for raw in keymap.min_keycode().raw()..=keymap.max_keycode().raw() {
        let keycode = xkb::Keycode::new(raw);
        for level in 0..keymap.num_levels_for_key(keycode, 0) {
            for keysym in keymap.key_get_syms_by_level(keycode, 0, level) {
                keycodes.entry(keysym.raw()).or_insert(raw);
            }
        }
    }
    keycodes
}

/// The accessibility bus, when a screen reader or the desktop has enabled
/// assistive technology (`org.a11y.Status`).
async fn connect() -> Option<zbus::Connection> {
    let session = zbus::Connection::session().await.ok()?;
    let status = |property: &'static str| {
        let session = session.clone();
        async move {
            let reply = session
                .call_method(
                    Some("org.a11y.Bus"),
                    "/org/a11y/bus",
                    Some("org.freedesktop.DBus.Properties"),
                    "Get",
                    &("org.a11y.Status", property),
                )
                .await
                .ok()?;
            let value: zbus::zvariant::OwnedValue = reply.body().deserialize().ok()?;
            bool::try_from(value).ok()
        }
    };
    if status("ScreenReaderEnabled").await != Some(true) && status("IsEnabled").await != Some(true)
    {
        return None;
    }
    let address = match std::env::var("AT_SPI_BUS_ADDRESS") {
        Ok(address) if !address.is_empty() => address,
        _ => session
            .call_method(
                Some("org.a11y.Bus"),
                "/org/a11y/bus",
                Some("org.a11y.Bus"),
                "GetAddress",
                &(),
            )
            .await
            .ok()?
            .body()
            .deserialize::<String>()
            .ok()?,
    };
    zbus::connection::Builder::address(address.as_str())
        .ok()?
        .method_timeout(TIMEOUT)
        .build()
        .await
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stroke(source: &'static str, key_char: Option<&str>) -> Keystroke {
        let mut keystroke = Keystroke::parse(source).unwrap();
        keystroke.key_char = key_char.map(str::to_owned);
        keystroke
    }

    fn name(source: &'static str, key_char: Option<&str>) -> (String, Option<String>) {
        let (keysym, text) = keysym(&stroke(source, key_char)).unwrap();
        (xkb::keysym_get_name(keysym), text)
    }

    #[test]
    fn keystrokes_become_x_keysyms_and_text() {
        assert_eq!(name("enter", None), ("Return".into(), None));
        assert_eq!(name("shift-tab", None), ("ISO_Left_Tab".into(), None));
        assert_eq!(name("left", None), ("Left".into(), None));
        assert_eq!(name("pagedown", None), ("Next".into(), None));
        assert_eq!(name("x", Some("x")), ("x".into(), Some("x".into())));
        assert_eq!(name("shift-x", Some("X")), ("X".into(), Some("X".into())));
        assert_eq!(name("space", Some(" ")), ("space".into(), Some(" ".into())));
        assert_eq!(name("ctrl-a", None), ("a".into(), None));
        assert_eq!(name("f5", None), ("F5".into(), None));
    }

    #[test]
    fn us_keycodes_are_x_keycodes() {
        let keycodes = us_keycodes();
        let code = |name: &str| keycodes[&xkb::keysym_from_name(name, xkb::KEYSYM_NO_FLAGS).raw()];
        assert_eq!(code("Return"), 36);
        assert_eq!(code("Left"), 113);
        assert_eq!(code("x"), 53);
        assert_eq!(code("X"), 53);
        assert_eq!(code("ISO_Left_Tab"), 23);
        assert_eq!(code("KP_Enter"), 104);
    }
}
