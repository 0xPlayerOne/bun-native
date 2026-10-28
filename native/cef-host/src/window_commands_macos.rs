//! Contributor-only input for an already-authorized CEF popup. No global input,
//! delayed callback, application delegate invocation, or synthetic receipt.
use cef::{ImplWindow, Window};
use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSView};
use objc2_foundation::{NSInteger, NSPoint, NSProcessInfo, NSString};

fn selection_events(window: NSInteger, timestamp: f64) -> Option<[Retained<NSEvent>; 4]> {
    let down = NSString::from_str("\u{f701}");
    let enter = NSString::from_str("\r");
    let key = |kind, characters: &NSString, code| {
        NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind,
            NSPoint::new(0.0, 0.0),
            NSEventModifierFlags::empty(),
            timestamp,
            window,
            None,
            characters,
            characters,
            false,
            code,
        )
    };
    Some([
        key(NSEventType::KeyDown, &down, 125)?,
        key(NSEventType::KeyUp, &down, 125)?,
        key(NSEventType::KeyDown, &enter, 36)?,
        key(NSEventType::KeyUp, &enter, 36)?,
    ])
}

pub(super) fn queue_first_selection(window: &Window) -> Result<(), &'static str> {
    let mtm = MainThreadMarker::new().ok_or("Menu input requires the native main thread")?;
    // Pinned CEF view_util_mac.mm returns its widget's NSView*, not NSWindow*.
    // Keep both owners alive until all events have entered the local queue.
    let view = unsafe { Retained::retain(window.window_handle().cast::<NSView>()) }
        .ok_or("Menu owner view unavailable")?;
    let owner = view.window().ok_or("Menu owner window unavailable")?;
    if !owner.isVisible() || owner.isMiniaturized() || !owner.isKeyWindow() {
        return Err("Menu input requires the active visible owner window");
    }
    let number = owner.windowNumber();
    if number <= 0 {
        return Err("Menu owner window number unavailable");
    }
    // Construct the complete finite sequence before posting anything. AppKit's
    // modal menu loop consumes these queued events after MenuWillShow returns.
    let events = selection_events(number, NSProcessInfo::processInfo().systemUptime())
        .ok_or("Menu input event construction failed")?;
    let application = NSApplication::sharedApplication(mtm);
    for event in events {
        application.postEvent_atStart(&event, false);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_selection_events_keep_the_exact_window_and_key_sequence() {
        let events = selection_events(73, 1.0).unwrap();
        for (event, (kind, code, characters)) in events.iter().zip([
            (NSEventType::KeyDown, 125, "\u{f701}"),
            (NSEventType::KeyUp, 125, "\u{f701}"),
            (NSEventType::KeyDown, 36, "\r"),
            (NSEventType::KeyUp, 36, "\r"),
        ]) {
            assert_eq!(event.windowNumber(), 73);
            assert_eq!(event.r#type(), kind);
            assert_eq!(event.keyCode(), code);
            assert_eq!(event.characters().unwrap().to_string(), characters);
            assert_eq!(
                event.charactersIgnoringModifiers().unwrap().to_string(),
                characters
            );
            assert_eq!(event.modifierFlags(), NSEventModifierFlags::empty());
            assert!(!event.isARepeat());
        }
    }
}
