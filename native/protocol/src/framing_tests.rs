//! Parity between the fast command decoder and the `Value`-based reference.

use super::{decode_command, decode_command_last_wins, EventWriter, ProtocolError};
use crate::{
    Command, CommandReader, Event, EventSequence, NodeId, WindowId, MAX_FRAME_BYTES, MAX_TEXT_BYTES,
};
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::io::Cursor;

const FIXTURES: [&str; 6] = [
    include_str!("../../../tests/fixtures/bridge-security.json"),
    include_str!("../../../tests/fixtures/native-services.json"),
    include_str!("../../../tests/fixtures/native-clipboard.json"),
    include_str!("../../../tests/fixtures/native-global-shortcuts.json"),
    include_str!("../../../tests/fixtures/native-notifications.json"),
    include_str!("../../../tests/fixtures/native-events.json"),
];

fn collect_wires(value: &Value, wires: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                match (key.as_str(), value) {
                    ("wire", Value::String(wire)) => wires.push(wire.clone()),
                    _ => collect_wires(value, wires),
                }
            }
        }
        Value::Array(values) => values.iter().for_each(|value| collect_wires(value, wires)),
        _ => {}
    }
}

/// Every shared command/event wire plus every shared layout case in a batch.
fn corpus() -> Vec<String> {
    let mut wires = Vec::new();
    for fixture in FIXTURES {
        collect_wires(&serde_json::from_str(fixture).unwrap(), &mut wires);
    }
    let layout: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/layout-style.json")).unwrap();
    for case in layout["cases"].as_array().unwrap() {
        wires.push(
            json!({"type":"batch","id":1,"window_id":1,"base_revision":0,"operations":[
                {"type":"create","node_id":2,"element":case["element"]},
                {"type":"set","node_id":2,"element":case["element"],"expected_input_revision":3},
                {"type":"insert","parent_id":1,"child_id":2,"index":0},
                {"type":"delete","node_id":2}
            ]})
            .to_string(),
        );
    }
    wires.push(
        json!({"id":1,"type":"register_global_shortcut","window_id":1,"shortcut_id":1,"key":"k",
            "modifiers":{"control":true,"alt":false,"shift":false,"platform":false}})
        .to_string(),
    );
    assert!(wires.len() > 150, "fixture corpus unexpectedly small");
    wires
}

/// How `emit` spells the object member with depth-first index `target`.
#[derive(Clone, Copy)]
enum Mutation<'a> {
    None,
    Reverse,
    Repeat(usize),
    Before(usize, &'a str),
    After(usize, &'a str),
}

fn emit(value: &Value, mutation: Mutation<'_>, counter: &mut usize, out: &mut String) {
    match value {
        Value::Object(object) => {
            out.push('{');
            let mut members: Vec<_> = object.iter().collect();
            if matches!(mutation, Mutation::Reverse) {
                members.reverse();
            }
            for (position, (key, member)) in members.into_iter().enumerate() {
                if position > 0 {
                    out.push(',');
                }
                let index = *counter;
                *counter += 1;
                let key = Value::String(key.clone());
                let mut spelled = String::new();
                emit(member, mutation, counter, &mut spelled);
                match mutation {
                    Mutation::Before(target, decoy) if target == index => {
                        write!(out, "{key}:{decoy},{key}:{spelled}")
                    }
                    Mutation::After(target, decoy) if target == index => {
                        write!(out, "{key}:{spelled},{key}:{decoy}")
                    }
                    Mutation::Repeat(target) if target == index => {
                        write!(out, "{key}:{spelled},{key}:{spelled}")
                    }
                    _ => write!(out, "{key}:{spelled}"),
                }
                .unwrap();
            }
            out.push('}');
        }
        Value::Array(values) => {
            out.push('[');
            for (position, value) in values.iter().enumerate() {
                if position > 0 {
                    out.push(',');
                }
                emit(value, mutation, counter, out);
            }
            out.push(']');
        }
        scalar => write!(out, "{scalar}").unwrap(),
    }
}

/// Returns the spelled frame and how many object members it has.
fn spell(value: &Value, mutation: Mutation<'_>) -> (String, usize) {
    let (mut out, mut members) = (String::new(), 0);
    emit(value, mutation, &mut members, &mut out);
    (out, members)
}

fn assert_parity(frame: &str) -> Result<Command, String> {
    let fast = decode_command(frame.as_bytes()).map_err(|error| error.to_string());
    let reference = decode_command_last_wins(frame.as_bytes()).map_err(|error| error.to_string());
    assert_eq!(fast, reference, "decoders disagree on {frame}");
    fast
}

#[test]
fn fast_decode_matches_reference_on_shared_fixtures_and_duplicate_key_mutations() {
    let decoys = ["null", "\"decoy\"", "{}", "-1"];
    let mut duplicated = 0;
    for wire in corpus() {
        let verbatim = assert_parity(&wire);
        let Ok(value) = serde_json::from_str::<Value>(&wire) else {
            continue;
        };
        let original = assert_parity(&spell(&value, Mutation::None).0);
        assert_eq!(original.is_ok(), verbatim.is_ok(), "{wire}");
        let (reversed, members) = spell(&value, Mutation::Reverse);
        let reversed = assert_parity(&reversed);
        if original.is_ok() {
            assert_eq!(reversed, original, "member order changed {wire}");
        }
        for member in 0..members {
            // Repeating a member with its own value is a last-wins no-op.
            let (same, _) = spell(&value, Mutation::Repeat(member));
            assert_eq!(assert_parity(&same), original, "{same}");
            for decoy in decoys {
                // The last member wins, so an earlier decoy never matters.
                let (earlier, _) = spell(&value, Mutation::Before(member, decoy));
                assert_eq!(assert_parity(&earlier), original, "{earlier}");
                let (later, _) = spell(&value, Mutation::After(member, decoy));
                let _ = assert_parity(&later);
                for frame in [&same, &earlier, &later] {
                    // The invariant the fast path relies on: the typed decoder
                    // refuses every frame that repeats a key anywhere.
                    assert!(
                        serde_json::from_slice::<Command>(frame.as_bytes()).is_err(),
                        "typed decoding accepted a duplicate key in {frame}"
                    );
                }
                duplicated += 3;
            }
        }
    }
    assert!(duplicated > 1_000, "only {duplicated} duplicate-key frames");
}

fn read(frame: &str) -> Result<Option<Command>, ProtocolError> {
    CommandReader::default().read(&mut Cursor::new(format!("{frame}\n")))
}

#[test]
fn nested_duplicate_keys_keep_last_member_semantics() {
    let nested = concat!(
        r#"{"type":"batch","id":1,"window_id":1,"window_id":"x","window_id":1,"base_revision":0,"#,
        r#""operations":[{"type":"delete","node_id":2,"type":"create","element":{"kind":"box","#,
        r#""kind":"text","text":"a","text":"b","style":{"gap":-1,"gap":4}}}]}"#
    );
    let Some(Command::Batch { operations, .. }) = read(nested).unwrap() else {
        panic!("nested duplicates were not decoded as a batch");
    };
    assert_eq!(
        serde_json::to_value(&operations).unwrap(),
        json!([{"type":"create","node_id":2,"element":{"kind":"text","text":"b","style":{"gap":4.0}}}])
    );
    for frame in [
        r#"{"id":1,"type":"shutdown","type":"file_read"}"#,
        r#"{"id":1,"type":"close","window_id":1,"window_id":null}"#,
        r#"{"id":1,"type":"batch","window_id":1,"base_revision":0,"operations":[{"type":"create","node_id":2,"element":{"kind":"text","text":"a","style":{"gap":4,"gap":-1}}}]}"#,
    ] {
        assert!(read(frame).is_err(), "accepted {frame}");
    }
}

#[test]
fn reader_reuses_its_frame_buffer_and_releases_it_when_done() {
    let mut reader = CommandReader::default();
    let large = format!(
        r#"{{"id":1,"type":"shutdown"}}{}"#,
        " ".repeat(MAX_FRAME_BYTES - 100)
    );
    let mut source = Cursor::new(format!("{large}\n{{\"id\":2,\"type\":\"shutdown\"}}\n"));
    assert!(matches!(
        reader.read(&mut source),
        Ok(Some(Command::Shutdown { .. }))
    ));
    let capacity = reader.frame.capacity();
    assert!((MAX_FRAME_BYTES - 100..=2 * MAX_FRAME_BYTES).contains(&capacity));
    assert!(matches!(
        reader.read(&mut source),
        Ok(Some(Command::Shutdown { .. }))
    ));
    assert_eq!(
        reader.frame.capacity(),
        capacity,
        "frame buffer was not reused"
    );
    assert_eq!(reader.read(&mut source).unwrap(), None);
    assert_eq!(reader.frame.capacity(), 0);
}

fn input(value: String) -> Event {
    let node = NodeId::try_from(2).unwrap();
    Event::Input {
        sequence: EventSequence::try_from(1).unwrap(),
        window_id: WindowId::try_from(1).unwrap(),
        node_id: node,
        tree_revision: 1,
        path: vec![NodeId::try_from(1).unwrap(), node],
        value,
        input_revision: 1,
    }
}

#[test]
fn event_writer_matches_one_shot_frames_and_bounds_its_buffer() {
    let mut writer = EventWriter::default();
    let mut reused = Vec::new();
    let mut one_shot = Vec::new();
    for value in ["a".repeat(MAX_TEXT_BYTES), String::new(), "界🌍".into()] {
        let event = input(value);
        writer.write(&mut reused, &event).unwrap();
        super::write_event(&mut one_shot, &event).unwrap();
    }
    assert_eq!(reused, one_shot);
    assert!(writer.buffer.capacity() <= 2 * MAX_FRAME_BYTES);

    // Control characters escape to six bytes each, past the frame limit.
    let oversized = input("\u{1}".repeat(MAX_TEXT_BYTES));
    let mut sink = Vec::new();
    assert!(matches!(
        writer.write(&mut sink, &oversized),
        Err(ProtocolError::Oversized)
    ));
    assert!(sink.is_empty(), "a rejected event wrote a partial frame");
    assert!(writer.buffer.capacity() <= MAX_FRAME_BYTES + 1);
    assert!(matches!(
        super::write_event(&mut sink, &oversized),
        Err(ProtocolError::Oversized)
    ));
}
