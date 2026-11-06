//! File dialog wire bounds are headless; the native portal run is separate.

use crate::{
    write_event, DialogId, Event, EventSequence, FileDialogResult, ServicePolicy, WindowId,
    MAX_DIALOG_PATHS, MAX_FRAME_BYTES,
};

#[test]
fn file_dialog_grant_is_optional_on_the_wire_and_absent_when_denied() {
    let existing = serde_json::json!({
        "window_display": false,
        "clipboard_read": false,
        "clipboard_write": false,
        "global_shortcuts": false,
        "notifications": false,
        "filesystem_roots": [],
        "processes": [],
    });
    let policy: ServicePolicy = serde_json::from_value(existing.clone()).unwrap();
    assert!(!policy.file_dialogs);
    assert_eq!(serde_json::to_value(policy).unwrap(), existing);
    let granted = ServicePolicy {
        file_dialogs: true,
        ..ServicePolicy::default()
    };
    let wire = serde_json::to_value(&granted).unwrap();
    assert_eq!(wire["file_dialogs"], true);
    assert_eq!(
        serde_json::from_value::<ServicePolicy>(wire).unwrap(),
        granted
    );
    for value in ["null", "1", "\"allow\""] {
        let wire = format!(
            "{{\"window_display\":false,\"clipboard_read\":false,\"clipboard_write\":false,\"global_shortcuts\":false,\"notifications\":false,\"filesystem_roots\":[],\"processes\":[],\"file_dialogs\":{value}}}"
        );
        assert!(
            serde_json::from_str::<ServicePolicy>(&wire).is_err(),
            "{value}"
        );
    }
}

/// A selection that is valid path by path can still exceed one frame; the
/// host measures the encoded event and reports `payload_too_large` instead.
#[test]
fn a_maximal_selection_can_exceed_the_frame_and_must_be_measured() {
    let event = |paths: Vec<String>| Event::FileDialogCompleted {
        sequence: EventSequence::try_from(1).unwrap(),
        window_id: WindowId::try_from(1).unwrap(),
        dialog_id: DialogId::try_from(1).unwrap(),
        result: FileDialogResult::Selected { paths },
    };
    let small = event(vec!["/a".into(); MAX_DIALOG_PATHS]);
    assert!(small.validate().is_ok());
    let mut bytes = Vec::new();
    write_event(&mut bytes, &small).unwrap();
    assert!(bytes.len() < MAX_FRAME_BYTES);
    let large = event(vec![format!("/{}", "a".repeat(1_000)); MAX_DIALOG_PATHS]);
    assert!(large.validate().is_ok());
    assert!(serde_json::to_vec(&large).unwrap().len() > MAX_FRAME_BYTES);
}
