//! `split_resize_v1` and `accessibility_v1`: the shared corpora.

use super::*;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::Cursor;

fn same(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && b.iter()
                    .all(|(key, b)| a.get(key).is_some_and(|a| same(a, b)))
        }
        _ => actual == expected,
    }
}

#[test]
fn split_resize_events_match_javascript() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/split-resize.json")).unwrap();
    assert_eq!(fixtures["protocol"], json!(PROTOCOL_VERSION));
    assert_eq!(fixtures["capability"], json!(Capability::SplitResizeV1));
    let mut names = BTreeSet::new();
    for case in fixtures["cases"].as_array().unwrap() {
        assert!(names.insert(case["name"].as_str().unwrap()));
        let wire = case["wire"].as_str().unwrap();
        let parsed = serde_json::from_str::<Event>(wire);
        let valid = parsed.as_ref().is_ok_and(|event| event.validate().is_ok());
        assert_eq!(
            valid,
            case["valid"] == json!(true),
            "{}: {parsed:?}",
            case["name"]
        );
        if valid {
            let event = parsed.unwrap();
            let mut bytes = Vec::new();
            write_event(&mut bytes, &event).unwrap();
            assert_eq!(serde_json::from_slice::<Event>(&bytes).unwrap(), event);
        }
    }
    for ratio in [f64::NAN, f64::INFINITY, -0.5, 1.5] {
        let event = Event::SplitResize {
            sequence: EventSequence::try_from(1).unwrap(),
            window_id: WindowId::try_from(1).unwrap(),
            node_id: NodeId::try_from(2).unwrap(),
            tree_revision: 1,
            path: vec![NodeId::try_from(1).unwrap(), NodeId::try_from(2).unwrap()],
            ratio,
            source: ResizeSource::Keyboard,
        };
        assert!(event.validate().is_err(), "{ratio}");
    }
}

#[test]
fn accessible_labels_match_javascript() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/accessibility.json")).unwrap();
    assert_eq!(
        fixtures["capabilities"],
        json!([Capability::SplitResizeV1, Capability::AccessibilityV1])
    );
    for case in fixtures["cases"].as_array().unwrap() {
        let batch = json!({"type":"batch","id":1,"window_id":1,"base_revision":0,"operations":[{"type":"create","node_id":2,"element":case["element"]}]});
        let result =
            CommandReader::default().read(&mut Cursor::new(format!("{batch}\n").as_bytes()));
        let expected = case.get("expected");
        assert_eq!(
            result.is_ok(),
            expected.is_some(),
            "{}: {result:?}",
            case["name"]
        );
        if let Some(expected) = expected {
            let element: Element = serde_json::from_value(case["element"].clone()).unwrap();
            let actual = serde_json::to_value(&element).unwrap();
            assert!(same(&actual, expected), "{}: {actual}", case["name"]);
        }
    }
}

#[test]
fn accessible_labels_count_toward_text_budgets() {
    let split = Element::Split {
        ratio: 0.5,
        min_size: 0.,
        accessible_label: Some("Sidebar".into()),
        style: Style::default(),
    };
    assert_eq!(split.text_bytes(), 7);
    assert_eq!(split.accessible_label(), Some("Sidebar"));
    let unlabeled = Element::Split {
        ratio: 0.5,
        min_size: 0.,
        accessible_label: None,
        style: Style::default(),
    };
    assert_eq!(unlabeled.text_bytes(), 0);
    // An unlabeled element keeps its exact earlier wire form.
    assert!(serde_json::to_value(&unlabeled)
        .unwrap()
        .get("accessible_label")
        .is_none());
}

#[test]
fn list_accessibility_matches_javascript() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/accessibility-lists.json"
    ))
    .unwrap();
    assert_eq!(
        fixtures["capability"],
        json!(Capability::AccessibilityListsV1)
    );
    let mut names = BTreeSet::new();
    for case in fixtures["cases"].as_array().unwrap() {
        assert!(names.insert(case["name"].as_str().unwrap()));
        let batch = json!({"type":"batch","id":1,"window_id":1,"base_revision":0,"operations":[{"type":"create","node_id":2,"element":case["element"]}]});
        let result =
            CommandReader::default().read(&mut Cursor::new(format!("{batch}\n").as_bytes()));
        let expected = case.get("expected");
        assert_eq!(
            result.is_ok(),
            expected.is_some(),
            "{}: {result:?}",
            case["name"]
        );
        if let Some(expected) = expected {
            let element: Element = serde_json::from_value(case["element"].clone()).unwrap();
            let actual = serde_json::to_value(&element).unwrap();
            assert!(same(&actual, expected), "{}: {actual}", case["name"]);
            assert_eq!(serde_json::from_value::<Element>(actual).unwrap(), element);
        }
    }
}

#[test]
fn list_labels_count_toward_text_budgets() {
    let list = Element::Box {
        accessibility: BoxAccessibility {
            accessible_role: Some(AccessibleRole::List),
            accessible_label: Some("Messages".into()),
            accessible_set_size: Some(3),
            ..BoxAccessibility::default()
        },
        style: Style::default(),
    };
    assert_eq!(list.text_bytes(), 8);
    assert_eq!(list.accessible_label(), Some("Messages"));
    // A plain box keeps its exact earlier wire form.
    let plain = Element::Box {
        accessibility: BoxAccessibility::default(),
        style: Style::default(),
    };
    assert_eq!(
        serde_json::to_value(&plain).unwrap(),
        json!({"kind":"box","style":{}})
    );
}
