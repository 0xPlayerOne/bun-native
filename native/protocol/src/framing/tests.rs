//! Edge cases of the bounded frame reader and event writer, plus the wire
//! validation boundaries they enforce on every decoded command.

use super::*;
use crate::{
    Capability, DialogId, Element, ErrorCode, EventSequence, FileDialogResult, Limits, NodeId,
    Operation, RequestId, ServicePolicy, WindowId, MAX_ID, MAX_NODES_PER_WINDOW, MAX_OPERATIONS,
    MAX_TEXT_BYTES, MAX_TITLE_BYTES, PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use std::io::{BufReader, Cursor, Read};

fn read(bytes: &[u8]) -> Result<Option<Command>, ProtocolError> {
    CommandReader::default().read(&mut Cursor::new(bytes))
}
fn read_json(value: &Value) -> Result<Option<Command>, ProtocolError> {
    read(format!("{value}\n").as_bytes())
}
fn accepted(value: &Value) -> Command {
    match read_json(value) {
        Ok(Some(command)) => command,
        other => panic!("rejected {value}: {other:?}"),
    }
}
fn rejected(value: &Value) {
    assert!(read_json(value).is_err(), "accepted {value}");
}
fn batch(operations: Value) -> Value {
    json!({"type":"batch","id":1,"window_id":1,"base_revision":0,"operations":operations})
}
fn create(element: Value) -> Value {
    batch(json!([{"type":"create","node_id":2,"element":element}]))
}
fn open() -> Value {
    json!({"id":1,"type":"open","window_id":1,"root_id":1,"title":"Native","width":640,"height":480})
}
fn shutdown_frame() -> Vec<u8> {
    br#"{"id":1,"type":"shutdown"}"#.to_vec()
}

struct FailingSource;
impl Read for FailingSource {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "gone"))
    }
}

#[test]
fn oversized_frame_split_across_buffer_refills_is_rejected() {
    // The limit applies to the accumulated frame, not to one buffer fill.
    let mut bytes = shutdown_frame();
    bytes.resize(MAX_FRAME_BYTES + 1, b' ');
    bytes.push(b'\n');
    let mut source = BufReader::with_capacity(7, Cursor::new(bytes));
    let mut reader = CommandReader::default();
    assert!(matches!(
        reader.read(&mut source),
        Err(ProtocolError::Oversized)
    ));
    assert!(matches!(
        reader.read(&mut source),
        Err(ProtocolError::Poisoned)
    ));
}

#[test]
fn exact_limit_frame_split_across_buffer_refills_is_accepted() {
    let mut bytes = shutdown_frame();
    bytes.resize(MAX_FRAME_BYTES, b' ');
    bytes.push(b'\n');
    bytes.extend_from_slice(b"{\"id\":2,\"type\":\"shutdown\"}\n");
    let mut source = BufReader::with_capacity(5, Cursor::new(bytes));
    let mut reader = CommandReader::default();
    assert_eq!(
        reader
            .read(&mut source)
            .unwrap()
            .map(|command| command.id()),
        Some(RequestId::try_from(1).unwrap())
    );
    assert_eq!(
        reader
            .read(&mut source)
            .unwrap()
            .map(|command| command.id()),
        Some(RequestId::try_from(2).unwrap())
    );
    assert_eq!(reader.read(&mut source).unwrap(), None);
}

#[test]
fn terminated_frame_one_byte_over_the_limit_is_oversized() {
    let mut bytes = shutdown_frame();
    bytes.resize(MAX_FRAME_BYTES + 1, b' ');
    bytes.push(b'\n');
    assert!(matches!(read(&bytes), Err(ProtocolError::Oversized)));
}

#[test]
fn eof_inside_a_frame_is_truncated_and_poisons() {
    let mut source = Cursor::new(b"{\"id\":1,\"type\":\"shutdown\"}\n{\"id\":2".to_vec());
    let mut reader = CommandReader::default();
    assert!(reader.read(&mut source).unwrap().is_some());
    assert!(matches!(
        reader.read(&mut source),
        Err(ProtocolError::Truncated)
    ));
    assert!(matches!(
        reader.read(&mut source),
        Err(ProtocolError::Poisoned)
    ));
}

#[test]
fn io_failure_is_reported_once_then_poisons() {
    let mut source = BufReader::new(FailingSource);
    let mut reader = CommandReader::default();
    assert!(matches!(
        reader.read(&mut source),
        Err(ProtocolError::Io(error)) if error.kind() == io::ErrorKind::BrokenPipe
    ));
    let mut valid = Cursor::new(b"{\"id\":1,\"type\":\"shutdown\"}\n");
    assert!(matches!(
        reader.read(&mut valid),
        Err(ProtocolError::Poisoned)
    ));
}

#[test]
fn semantic_failures_are_invalid_command_and_shape_failures_are_invalid_json() {
    let mut empty_title = open();
    empty_title["title"] = json!("");
    assert!(matches!(
        read_json(&empty_title),
        Err(ProtocolError::InvalidCommand(_))
    ));
    assert!(matches!(
        read(b"{\"id\":1,\"type\":\"teleport\"}\n"),
        Err(ProtocolError::InvalidJson(_))
    ));
    assert!(matches!(
        read(b"{\"id\":1,\"type\":\"shutdown\"\n"),
        Err(ProtocolError::InvalidJson(_))
    ));
}

#[test]
fn json_whitespace_around_a_frame_including_carriage_return_is_allowed() {
    // JSON.parse treats CR, tab and space as insignificant whitespace.
    assert!(read(b" \t{\"id\":1,\"type\":\"shutdown\"}\r\n")
        .unwrap()
        .is_some());
    assert!(read(b"\r\n").is_err());
}

#[test]
fn malformed_utf8_inside_a_frame_is_rejected() {
    // A truncated multi-byte sequence, an overlong encoding and an encoded
    // surrogate are not UTF-8, even inside an otherwise valid string.
    for bytes in [
        b"\"\xe7\x95\"".as_slice(),
        b"\"\xc0\xaf\"",
        b"\"\xed\xa0\x80\"",
    ] {
        let mut frame =
            b"{\"id\":1,\"type\":\"open\",\"window_id\":1,\"root_id\":1,\"title\":".to_vec();
        frame.extend_from_slice(bytes);
        frame.extend_from_slice(b",\"width\":640,\"height\":480}\n");
        assert!(
            matches!(read(&frame), Err(ProtocolError::InvalidJson(_))),
            "accepted {bytes:?}"
        );
    }
}

#[test]
fn display_messages_are_stable() {
    assert_eq!(
        ProtocolError::Oversized.to_string(),
        "frame exceeds its byte limit"
    );
    assert_eq!(
        ProtocolError::Truncated.to_string(),
        "channel ended within a frame"
    );
    assert_eq!(ProtocolError::Poisoned.to_string(), "channel is poisoned");
    assert_eq!(ProtocolError::InvalidCommand("bad").to_string(), "bad");
    assert_eq!(ProtocolError::InvalidEvent("worse").to_string(), "worse");
    assert!(ProtocolError::Io(io::Error::other("x"))
        .to_string()
        .starts_with("channel I/O failed"));
}

#[test]
fn invalid_events_write_nothing() {
    let event = Event::Click {
        sequence: EventSequence::try_from(1).unwrap(),
        window_id: WindowId::try_from(1).unwrap(),
        node_id: NodeId::try_from(2).unwrap(),
        tree_revision: 1,
        path: vec![],
    };
    let mut bytes = Vec::new();
    assert!(matches!(
        write_event(&mut bytes, &event),
        Err(ProtocolError::InvalidEvent(_))
    ));
    assert!(bytes.is_empty());
}

#[test]
fn oversized_events_write_nothing_and_the_limit_is_inclusive() {
    // Dialog selections are the largest events that pass validation, so
    // their last path is sized to land the frame exactly on the limit.
    let event = |last: usize| Event::FileDialogCompleted {
        sequence: EventSequence::try_from(1).unwrap(),
        window_id: WindowId::try_from(1).unwrap(),
        dialog_id: DialogId::try_from(1).unwrap(),
        result: FileDialogResult::Selected {
            paths: std::iter::repeat_n(format!("/{}", "a".repeat(3_000)), 21)
                .chain([format!("/{}", "a".repeat(last))])
                .collect(),
        },
    };
    let base = serde_json::to_vec(&event(0)).unwrap().len();
    let exact = event(MAX_EVENT_FRAME_BYTES - base);
    assert!(exact.validate().is_ok());
    let mut bytes = Vec::new();
    write_event(&mut bytes, &exact).unwrap();
    assert_eq!(bytes.len(), MAX_EVENT_FRAME_BYTES + 1);
    assert_eq!(bytes.last(), Some(&b'\n'));

    let over = event(MAX_EVENT_FRAME_BYTES - base + 1);
    assert!(over.validate().is_ok());
    let mut bytes = Vec::new();
    assert!(matches!(
        write_event(&mut bytes, &over),
        Err(ProtocolError::Oversized)
    ));
    assert!(bytes.is_empty());
}

#[test]
fn sink_failures_surface_as_io_errors() {
    struct Sink {
        fail_write: bool,
        flushed: bool,
    }
    impl Write for Sink {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if self.fail_write {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
            } else {
                Ok(buffer.len())
            }
        }
        fn flush(&mut self) -> io::Result<()> {
            self.flushed = true;
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
        }
    }
    let event = Event::Ack {
        id: RequestId::try_from(1).unwrap(),
    };
    for fail_write in [true, false] {
        let mut sink = Sink {
            fail_write,
            flushed: false,
        };
        assert!(matches!(
            write_event(&mut sink, &event),
            Err(ProtocolError::Io(_))
        ));
        assert_eq!(sink.flushed, !fail_write, "flush follows a full write");
    }
}

#[test]
fn identifier_and_revision_boundaries_are_inclusive() {
    assert_eq!(
        accepted(&json!({"id":MAX_ID,"type":"shutdown"})).id().get(),
        MAX_ID
    );
    let mut command = create(json!({"kind":"box"}));
    command["base_revision"] = json!(MAX_ID);
    accepted(&command);
    // -0 is a safe integer in JavaScript and decodes as revision 0.
    command["base_revision"] = json!(-0.0);
    assert!(matches!(
        accepted(&command),
        Command::Batch {
            base_revision: 0,
            ..
        }
    ));
    for revision in [json!(-1), json!(0.5), json!(1e300), json!("0"), json!(null)] {
        command["base_revision"] = revision;
        rejected(&command);
    }
    let set = |revision: Value| {
        batch(
            json!([{"type":"set","node_id":2,"element":{"kind":"input","value":""},"expected_input_revision":revision}]),
        )
    };
    accepted(&set(json!(MAX_ID)));
    rejected(&set(json!(MAX_ID + 1)));
    rejected(&set(json!(-1)));
}

#[test]
fn hello_protocol_must_fit_u32_but_any_version_decodes() {
    // Version negotiation happens after decoding; the reader only bounds it.
    assert!(matches!(
        accepted(&json!({"id":1,"type":"hello","protocol":PROTOCOL_VERSION + 1})),
        Command::Hello { protocol, .. } if protocol == PROTOCOL_VERSION + 1
    ));
    accepted(&json!({"id":1,"type":"hello","protocol":u32::MAX}));
    rejected(&json!({"id":1,"type":"hello","protocol":u64::from(u32::MAX) + 1}));
    rejected(&json!({"id":1,"type":"hello"}));
    rejected(&json!({"id":1,"type":"hello","protocol":"8"}));
}

#[test]
fn missing_required_fields_and_unknown_tags_are_rejected() {
    for command in [
        json!({"type":"shutdown"}),
        json!({"id":1}),
        json!({"id":1,"type":"Shutdown"}),
        json!({"id":1,"type":"close"}),
        json!({"id":1,"type":"open","window_id":1,"root_id":1,"title":"x","width":640}),
        json!({"id":1,"type":"batch","window_id":1,"base_revision":0}),
        batch(json!([{"type":"move","node_id":2}])),
        batch(json!([{"node_id":2}])),
        batch(json!([{"type":"insert","parent_id":1,"child_id":2}])),
        batch(json!([{"type":"delete","node_id":2,"recursive":true}])),
        batch(json!([{"type":"create","node_id":2}])),
        batch(json!([{"type":"create","node_id":2,"element":{"kind":"box"},"style":{}}])),
        create(json!({"kind":"image","src":"x"})),
        create(json!({"text":"no kind"})),
        create(json!({"kind":"text"})),
        create(json!({"kind":"button"})),
        create(json!({"kind":"input"})),
        create(json!({"kind":"box","text":"boxes carry no text"})),
        json!([{"id":1,"type":"shutdown"}]),
        json!("shutdown"),
    ] {
        rejected(&command);
    }
}

#[test]
fn operation_count_boundary_is_inclusive() {
    let operations = vec![json!({"type":"delete","node_id":2}); MAX_OPERATIONS];
    assert!(matches!(
        accepted(&batch(json!(operations))),
        Command::Batch { operations, .. } if operations.len() == MAX_OPERATIONS
    ));
}

#[test]
fn insert_index_boundary_matches_the_node_limit() {
    accepted(&batch(
        json!([{"type":"insert","parent_id":1,"child_id":2,"index":MAX_NODES_PER_WINDOW}]),
    ));
    rejected(&batch(
        json!([{"type":"insert","parent_id":1,"child_id":2,"index":-1}]),
    ));
}

#[test]
fn window_title_and_size_boundaries_are_inclusive() {
    for (field, value) in [
        ("title", json!("a".repeat(MAX_TITLE_BYTES))),
        // 85 three-byte characters plus one ASCII byte is exactly 256 bytes.
        ("title", json!(format!("{}a", "界".repeat(85)))),
        ("title", json!("no\u{a0}break space is not a control")),
        ("width", json!(64)),
        ("width", json!(16384)),
        ("height", json!(64)),
        ("height", json!(16384)),
    ] {
        let mut command = open();
        command[field] = value;
        accepted(&command);
    }
    for (field, value) in [
        ("title", json!("a".repeat(MAX_TITLE_BYTES + 1))),
        ("title", json!("tab\tname")),
        ("title", json!("del\u{7f}name")),
        ("title", json!("nul\u{0}name")),
        ("width", json!("640")),
        ("height", json!(null)),
    ] {
        let mut command = open();
        command[field] = value;
        rejected(&command);
    }
}

#[test]
fn text_byte_limit_is_inclusive_for_multibyte_text_and_every_text_field() {
    // 16384 = 4 * 4096, so a run of four-byte scalars reaches the limit exactly.
    let exact = "🌍".repeat(MAX_TEXT_BYTES / 4);
    let over = format!("{exact}a");
    accepted(&create(json!({"kind":"text","text":exact})));
    accepted(&create(json!({"kind":"button","text":exact})));
    accepted(&create(
        json!({"kind":"input","value":exact,"placeholder":exact}),
    ));
    for element in [
        json!({"kind":"text","text":over}),
        json!({"kind":"button","text":over}),
        json!({"kind":"input","value":over}),
        json!({"kind":"input","value":"","placeholder":over}),
        json!({"kind":"button","text":"a\u{0}"}),
        json!({"kind":"input","value":"","placeholder":"\u{0}"}),
    ] {
        rejected(&create(element));
    }
}

#[test]
fn set_operations_validate_their_element_like_create() {
    for element in [
        json!({"kind":"text","text":"\u{0}"}),
        json!({"kind":"box","style":{"gap":-1}}),
        json!({"kind":"button","text":"x","style":{"overflow":"scroll"}}),
    ] {
        rejected(&batch(
            json!([{"type":"set","node_id":2,"element":element}]),
        ));
    }
    accepted(&batch(
        json!([{"type":"set","node_id":2,"element":{"kind":"button","text":"x","disabled":true}}]),
    ));
}

#[test]
fn scrolling_overflow_is_reserved_for_boxes() {
    for overflow in ["scroll_x", "scroll_y", "scroll"] {
        accepted(&create(json!({"kind":"box","style":{"overflow":overflow}})));
        for mut element in [
            json!({"kind":"text","text":"x"}),
            json!({"kind":"button","text":"x"}),
            json!({"kind":"input","value":"x"}),
        ] {
            element["style"] = json!({"overflow":overflow});
            rejected(&create(element));
        }
    }
    for overflow in ["visible", "hidden"] {
        accepted(&create(
            json!({"kind":"text","text":"x","style":{"overflow":overflow}}),
        ));
    }
    rejected(&create(json!({"kind":"box","style":{"overflow":"auto"}})));
}

#[test]
fn size_constraints_allow_equal_minimum_and_maximum() {
    accepted(&create(
        json!({"kind":"box","style":{"min_width":10,"max_width":10,"min_height":0,"max_height":16384}}),
    ));
    for style in [
        json!({"min_width":10.5,"max_width":10}),
        json!({"min_height":1,"max_height":0}),
        json!({"max_width":16384.5}),
        json!({"min_height":-1}),
        json!({"flex_shrink":-0.5}),
        json!({"width":"Fill"}),
    ] {
        rejected(&create(json!({"kind":"box","style":style})));
    }
}

#[test]
fn color_boundaries_and_encodings_match_javascript_integers() {
    accepted(&create(
        json!({"kind":"box","style":{"background":0xff_ffff,"color":0}}),
    ));
    for color in [
        json!(0x100_0000),
        json!(-1),
        json!("#fff"),
        json!(u64::from(u32::MAX) + 1),
    ] {
        rejected(&create(json!({"kind":"box","style":{"background":color}})));
    }
}

#[test]
fn decoded_operations_preserve_their_typed_payloads() {
    let command = accepted(&batch(json!([
        {"type":"create","node_id":2,"element":{"kind":"input","value":"v","placeholder":"p"}},
        {"type":"insert","parent_id":1,"child_id":2,"index":0},
        {"type":"set","node_id":2,"element":{"kind":"input","value":"w"},"expected_input_revision":0},
        {"type":"delete","node_id":2}
    ])));
    let Command::Batch { operations, .. } = command else {
        panic!("expected batch");
    };
    assert!(matches!(
        &operations[0],
        Operation::Create { element: Element::Input { value, placeholder, .. }, .. }
            if value == "v" && placeholder == "p"
    ));
    assert!(matches!(
        &operations[2],
        Operation::Set {
            expected_input_revision: Some(0),
            ..
        }
    ));
}

#[test]
fn capability_and_error_code_spellings_are_closed_snake_case() {
    for (capability, wire) in [
        (Capability::Tree, "tree"),
        (Capability::InputRevisions, "input_revisions"),
        (Capability::LayoutV1, "layout_v1"),
        (Capability::InteractionsV1, "interactions_v1"),
        (Capability::WindowDisplayV1, "window_display_v1"),
        (Capability::ClipboardTextV1, "clipboard_text_v1"),
        (Capability::GlobalShortcutsV1, "global_shortcuts_v1"),
        (Capability::NotificationsV1, "notifications_v1"),
    ] {
        assert_eq!(serde_json::to_value(capability).unwrap(), json!(wire));
        assert_eq!(
            serde_json::from_value::<Capability>(json!(wire)).unwrap(),
            capability
        );
    }
    for unknown in ["filesystem_v1", "Tree", "layout-v1", ""] {
        assert!(serde_json::from_value::<Capability>(json!(unknown)).is_err());
    }
    assert_eq!(
        serde_json::to_value(ErrorCode::OperationTimedOut).unwrap(),
        json!("operation_timed_out")
    );
    assert!(serde_json::from_value::<ErrorCode>(json!("unknown_error")).is_err());
}

#[test]
fn ready_event_advertises_the_compiled_limits_and_rejects_unknown_fields() {
    let limits = Limits::default();
    assert_eq!(limits.max_frame_bytes, MAX_FRAME_BYTES);
    assert_eq!(limits.max_operations, MAX_OPERATIONS);
    assert_eq!(limits.max_text_bytes, MAX_TEXT_BYTES);
    let ready = Event::Ready {
        protocol: PROTOCOL_VERSION,
        capabilities: vec![Capability::Tree, Capability::LayoutV1],
        limits,
        service_policy: ServicePolicy::default(),
    };
    let mut bytes = Vec::new();
    write_event(&mut bytes, &ready).unwrap();
    let mut value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        serde_json::from_value::<Event>(value.clone()).unwrap(),
        ready
    );
    value["limits"]["max_files"] = json!(1);
    assert!(serde_json::from_value::<Event>(value.clone()).is_err());
    value["limits"].as_object_mut().unwrap().remove("max_files");
    value["capabilities"] = json!(["tree", "filesystem_v1"]);
    assert!(serde_json::from_value::<Event>(value).is_err());
}

/// The decoder before the plain-struct batch path: typed, then last-wins.
fn general_decode(frame: &[u8]) -> Result<Command, ProtocolError> {
    serde_json::from_slice(frame).or_else(|_| decode_command_last_wins(frame))
}

#[test]
fn batch_fast_path_decodes_exactly_what_the_general_path_does() {
    let element = r#"{"kind":"text","text":"a","style":{"gap":1}}"#;
    let frames = [
        // The runtime's normalized order, and others.
        format!(r#"{{"id":1,"type":"batch","window_id":2,"base_revision":3,"operations":[{{"type":"create","node_id":4,"element":{element}}}]}}"#),
        r#"{"type":"batch","id":1,"window_id":2,"base_revision":3,"operations":[{"type":"delete","node_id":4}]}"#.to_string(),
        r#"{"operations":[{"type":"delete","node_id":4}],"base_revision":3,"window_id":2,"type":"batch","id":1}"#.to_string(),
        r#"{ "id" : 1 , "type" : "batch" , "window_id" : 2 , "base_revision" : 0 , "operations" : [ ] }"#.to_string(),
        // Spellings of integers.
        r#"{"id":1.0,"type":"batch","window_id":2e0,"base_revision":3.0,"operations":[{"type":"delete","node_id":4}]}"#.to_string(),
        // Rejected shapes.
        r#"{"id":1,"type":"batch","window_id":2,"base_revision":3}"#.to_string(),
        r#"{"id":1,"type":"batch","window_id":2,"base_revision":3,"operations":[],"extra":1}"#.to_string(),
        r#"{"id":1,"type":"batch","window_id":2,"base_revision":3,"operations":null}"#.to_string(),
        r#"{"id":1,"type":"batch","window_id":2,"base_revision":-1,"operations":[]}"#.to_string(),
        r#"{"id":0,"type":"batch","window_id":2,"base_revision":3,"operations":[]}"#.to_string(),
        r#"{"id":1,"type":"batch","window_id":9007199254740992,"base_revision":3,"operations":[]}"#.to_string(),
        r#"{"id":1,"type":"batch","window_id":2,"base_revision":3,"operations":[{"type":"nope"}]}"#.to_string(),
        r#"{"id":1,"type":"batch","window_id":2,"base_revision":3,"operations":[{"type":"delete"}]}"#.to_string(),
        r#"{"id":1,"type":"Batch","window_id":2,"base_revision":3,"operations":[]}"#.to_string(),
        r#"{"id":1,"type":0,"window_id":2,"base_revision":3,"operations":[]}"#.to_string(),
        // Duplicate members decide by the last one (the general path).
        r#"{"id":1,"type":"batch","window_id":2,"base_revision":3,"base_revision":4,"operations":[]}"#.to_string(),
        r#"{"id":1,"id":5,"type":"batch","window_id":2,"base_revision":3,"operations":[]}"#.to_string(),
        r#"{"id":1,"type":"batch","type":"batch","window_id":2,"base_revision":3,"operations":[]}"#.to_string(),
        r#"{"id":1,"type":"batch","window_id":2,"base_revision":3,"operations":[],"operations":[{"type":"delete","node_id":4}]}"#.to_string(),
        r#"{"id":1,"type":"batch","window_id":2,"base_revision":3,"operations":[{"type":"delete","node_id":4,"node_id":5}]}"#.to_string(),
        // The tag is not first or is escaped, and is not a batch at all.
        r#"{"id":1,"type":"batch","window_id":2,"base_revision":3,"operations":[]}"#.to_string(),
        r#"{"id":1,"type":"close","window_id":2}"#.to_string(),
        r#"{"id":1,"type":"close","window_id":2,"type":"batch","base_revision":3,"operations":[]}"#.to_string(),
        r#"{"id":1,"type":"batch","window_id":2,"base_revision":3,"operations":[]} "#.to_string(),
        "\u{feff}{\"id\":1,\"type\":\"batch\"}".to_string(),
        String::new(),
        "{".to_string(),
    ];
    for frame in frames {
        let new = decode_command(frame.as_bytes());
        let old = general_decode(frame.as_bytes());
        match (&new, &old) {
            (Ok(new), Ok(old)) => assert_eq!(new, old, "{frame}"),
            (Err(_), Err(_)) => {}
            _ => panic!("paths disagree on {frame}: new {new:?}, old {old:?}"),
        }
    }
}
