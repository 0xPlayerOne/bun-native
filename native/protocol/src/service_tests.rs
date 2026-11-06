//! Shared service boundary cases are headless; native execution is separate.

use crate::{CommandReader, Event, ServicePolicy, PROTOCOL_VERSION};
use serde::Deserialize;
use std::io::Cursor;

#[derive(Deserialize)]
struct Case {
    name: String,
    wire: String,
    valid: bool,
}

#[derive(Deserialize)]
struct Fixtures {
    protocol: u32,
    capability: String,
    commands: Vec<Case>,
    events: Vec<Case>,
}

#[test]
fn service_commands_and_responses_share_the_checked_typescript_contract() {
    for (source, capability) in [
        (
            include_str!("../../../tests/fixtures/native-services.json"),
            "window_display_v1",
        ),
        (
            include_str!("../../../tests/fixtures/native-clipboard.json"),
            "clipboard_text_v1",
        ),
        (
            include_str!("../../../tests/fixtures/native-global-shortcuts.json"),
            "global_shortcuts_v1",
        ),
        (
            include_str!("../../../tests/fixtures/native-notifications.json"),
            "notifications_v1",
        ),
        (
            include_str!("../../../tests/fixtures/native-filesystem-grants.json"),
            "filesystem_grants_v1",
        ),
        (
            include_str!("../../../tests/fixtures/native-processes.json"),
            "processes_v1",
        ),
        (
            include_str!("../../../tests/fixtures/native-file-dialogs.json"),
            "file_dialogs_v1",
        ),
    ] {
        service_cases(source, capability);
    }
}

fn service_cases(source: &str, capability: &str) {
    let fixtures: Fixtures = serde_json::from_str(source).unwrap();
    assert_eq!(fixtures.protocol, PROTOCOL_VERSION);
    assert_eq!(fixtures.capability, capability);
    for case in fixtures.commands {
        let mut reader = CommandReader::default();
        let wire = format!("{}\n", case.wire);
        let result = reader.read(&mut Cursor::new(wire.as_bytes()));
        assert_eq!(result.is_ok(), case.valid, "{}", case.name);
        if !case.valid {
            assert!(reader
                .read(&mut Cursor::new(b"{\"type\":\"shutdown\",\"id\":2}\n"))
                .is_err());
        }
    }
    for case in fixtures.events {
        let valid = serde_json::from_str::<Event>(&case.wire)
            .ok()
            .is_some_and(|event| event.validate().is_ok());
        assert_eq!(valid, case.valid, "{}", case.name);
    }
}

#[test]
fn clipboard_payload_is_byte_bounded_even_after_json_escaping() {
    use crate::{
        write_event, ClipboardText, Command, RequestId, WindowId, MAX_CLIPBOARD_BYTES,
        MAX_FRAME_BYTES,
    };
    for text in [
        "é".repeat(MAX_CLIPBOARD_BYTES / 2),
        "\u{1}".repeat(MAX_CLIPBOARD_BYTES),
    ] {
        let id = RequestId::try_from(1).unwrap();
        let window_id = WindowId::try_from(1).unwrap();
        let event = Event::ClipboardText {
            id,
            window_id,
            result: ClipboardText::Text { text: text.clone() },
        };
        let mut bytes = Vec::new();
        write_event(&mut bytes, &event).unwrap();
        assert!(bytes.len() - 1 < MAX_FRAME_BYTES);
        let command = Command::ClipboardWrite {
            id,
            window_id,
            text: text.clone(),
        };
        assert!(command.validate().is_ok());
        assert!(Command::ClipboardWrite {
            id,
            window_id,
            text: text + "x"
        }
        .validate()
        .is_err());
    }
}

#[test]
fn service_policy_requires_an_explicit_boolean_and_denies_unrecognized_grants() {
    for value in [false, true] {
        let policy: ServicePolicy =
            serde_json::from_value(serde_json::json!({"window_display": value, "clipboard_read": false, "clipboard_write": false, "global_shortcuts": false, "notifications": false, "filesystem_roots": [], "processes": []})).unwrap();
        assert_eq!(policy.window_display, value);
    }
    for wire in [
        "{}",
        "{\"window_display\":null}",
        "{\"window_display\":1}",
        "{\"window_display\":\"allow\"}",
        "{\"window_display\":false,\"clipboard\":true}",
        "{\"window_display\":false,\"clipboard_read\":false,\"clipboard_write\":false,\"global_shortcuts\":false,\"notifications\":false}",
    ] {
        assert!(
            serde_json::from_str::<ServicePolicy>(wire).is_err(),
            "{wire}"
        );
    }
}

#[test]
fn global_shortcuts_accept_only_the_closed_key_set_with_a_non_shift_modifier() {
    use crate::{validate_global_shortcut, ShortcutModifiers};
    let control = ShortcutModifiers {
        control: true,
        ..ShortcutModifiers::default()
    };
    for key in ["a", "z", "0", "9", "f1", "f9", "f10", "f12"] {
        assert!(validate_global_shortcut(key, control).is_ok(), "{key}");
    }
    for key in ["", "A", "f0", "f13", "f01", "aa", "space", "\u{e9}", "-"] {
        assert!(validate_global_shortcut(key, control).is_err(), "{key}");
    }
    for modifiers in [
        ShortcutModifiers::default(),
        ShortcutModifiers {
            shift: true,
            ..ShortcutModifiers::default()
        },
    ] {
        assert!(validate_global_shortcut("k", modifiers).is_err());
    }
    for modifiers in [
        ShortcutModifiers {
            alt: true,
            ..ShortcutModifiers::default()
        },
        ShortcutModifiers {
            platform: true,
            shift: true,
            ..ShortcutModifiers::default()
        },
    ] {
        assert!(validate_global_shortcut("k", modifiers).is_ok());
    }
}
