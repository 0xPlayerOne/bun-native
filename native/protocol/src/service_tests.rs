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
            serde_json::from_value(serde_json::json!({"window_display": value, "clipboard_read": false, "clipboard_write": false})).unwrap();
        assert_eq!(policy.window_display, value);
    }
    for wire in [
        "{}",
        "{\"window_display\":null}",
        "{\"window_display\":1}",
        "{\"window_display\":\"allow\"}",
        "{\"window_display\":false,\"clipboard\":true}",
    ] {
        assert!(
            serde_json::from_str::<ServicePolicy>(wire).is_err(),
            "{wire}"
        );
    }
}
