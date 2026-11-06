//! OS message dialog wire bounds are headless; the native run is separate.

use crate::{
    Command, DialogId, Event, EventSequence, MessageDialogButton, MessageDialogOptions,
    MessageDialogResult, RequestId, ServicePolicy, WindowId,
};

type Change = Box<dyn Fn(&mut MessageDialogOptions)>;

fn options() -> MessageDialogOptions {
    MessageDialogOptions {
        title: "Unsaved changes".into(),
        message: "Save the document before closing?".into(),
        detail: Some("Unsaved edits are lost.\nThis cannot be undone.".into()),
        buttons: ["save", "discard", "cancel"]
            .into_iter()
            .map(|id| MessageDialogButton {
                id: id.into(),
                label: id.to_uppercase(),
            })
            .collect(),
        default_button: "save".into(),
        cancel_button: Some("cancel".into()),
        dismissible: false,
    }
}

#[test]
fn the_grant_is_optional_on_the_wire_and_absent_when_denied() {
    let existing = serde_json::json!({
        "window_display": false,
        "clipboard_read": false,
        "clipboard_write": false,
        "global_shortcuts": false,
        "notifications": false,
        "drag_drop": false,
        "filesystem_roots": [],
        "processes": [],
    });
    let policy: ServicePolicy = serde_json::from_value(existing.clone()).unwrap();
    assert!(!policy.task_dialogs);
    assert_eq!(serde_json::to_value(policy).unwrap(), existing);
    let granted = ServicePolicy {
        task_dialogs: true,
        ..ServicePolicy::default()
    };
    let wire = serde_json::to_value(&granted).unwrap();
    assert_eq!(wire["task_dialogs"], true);
    assert_eq!(
        serde_json::from_value::<ServicePolicy>(wire).unwrap(),
        granted
    );
    for value in ["null", "1", "\"allow\""] {
        let wire = format!(
            "{{\"window_display\":false,\"clipboard_read\":false,\"clipboard_write\":false,\"global_shortcuts\":false,\"notifications\":false,\"drag_drop\":false,\"filesystem_roots\":[],\"processes\":[],\"task_dialogs\":{value}}}"
        );
        assert!(
            serde_json::from_str::<ServicePolicy>(&wire).is_err(),
            "{value}"
        );
    }
}

#[test]
fn valid_options_round_trip_and_invalid_ones_are_refused() {
    options().validate().unwrap();
    let wire = serde_json::to_value(options()).unwrap();
    assert_eq!(wire["default_button"], "save");
    assert!(wire.get("dismissible").is_none());
    assert_eq!(
        serde_json::from_value::<MessageDialogOptions>(wire).unwrap(),
        options()
    );
    let refused: [(&str, Change); 11] = [
        ("blank title", Box::new(|o| o.title = " ".into())),
        ("multiline title", Box::new(|o| o.title = "a\nb".into())),
        ("tab in message", Box::new(|o| o.message = "a\tb".into())),
        ("blank message", Box::new(|o| o.message = "\n".into())),
        ("long message", Box::new(|o| o.message = "a".repeat(2_049))),
        (
            "long detail",
            Box::new(|o| o.detail = Some("a".repeat(4_097))),
        ),
        ("no buttons", Box::new(|o| o.buttons.clear())),
        (
            "five buttons",
            Box::new(|o| {
                o.buttons = (0..5)
                    .map(|i| MessageDialogButton {
                        id: format!("b{i}"),
                        label: "b".into(),
                    })
                    .collect()
            }),
        ),
        (
            "duplicate ids",
            Box::new(|o| o.buttons[1].id = "save".into()),
        ),
        (
            "unknown default",
            Box::new(|o| o.default_button = "x".into()),
        ),
        (
            "unknown cancel",
            Box::new(|o| o.cancel_button = Some("x".into())),
        ),
    ];
    for (name, change) in refused {
        let mut candidate = options();
        change(&mut candidate);
        assert!(candidate.validate().is_err(), "{name}");
    }
    let mut label = options();
    label.buttons[0].label = "a\nb".into();
    assert!(label.validate().is_err());
    assert!(
        serde_json::from_value::<MessageDialogOptions>(serde_json::json!({
            "title": "t", "message": "m",
            "buttons": [{"id": "a", "label": "A", "kind": "primary"}],
            "default_button": "a",
        }))
        .is_err(),
        "the overlay-only button kind never crosses the wire"
    );
}

#[test]
fn commands_and_events_validate_their_payloads() {
    let ids = (
        RequestId::try_from(1).unwrap(),
        WindowId::try_from(1).unwrap(),
        DialogId::try_from(1).unwrap(),
    );
    let show = Command::ShowMessageDialog {
        id: ids.0,
        window_id: ids.1,
        dialog_id: ids.2,
        options: options(),
    };
    assert!(show.validate().is_ok());
    let mut bad = options();
    bad.buttons.clear();
    assert!(Command::ShowMessageDialog {
        id: ids.0,
        window_id: ids.1,
        dialog_id: ids.2,
        options: bad,
    }
    .validate()
    .is_err());
    let completed = |result| Event::MessageDialogCompleted {
        sequence: EventSequence::try_from(1).unwrap(),
        window_id: ids.1,
        dialog_id: ids.2,
        result,
    };
    assert!(completed(MessageDialogResult::Button { id: "save".into() })
        .validate()
        .is_ok());
    assert!(completed(MessageDialogResult::Dismissed {})
        .validate()
        .is_ok());
    assert!(completed(MessageDialogResult::Button { id: "\n".into() })
        .validate()
        .is_err());
    assert_eq!(
        serde_json::to_value(MessageDialogResult::Dismissed {}).unwrap(),
        serde_json::json!({ "kind": "dismissed" })
    );
}
