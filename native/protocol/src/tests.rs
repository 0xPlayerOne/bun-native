use super::*;
use std::io::{BufReader, Cursor};

fn read(bytes: &[u8]) -> Result<Option<Command>, ProtocolError> {
    CommandReader::default().read(&mut Cursor::new(bytes))
}

#[test]
fn fragmented_utf8_and_multiple_frames_preserve_boundaries() {
    let bytes = "{\"id\":1,\"type\":\"open\",\"title\":\"Native\",\"text\":\"界🌍\",\"input\":\"\"}\n{\"id\":2,\"type\":\"close\"}\n";
    let mut source = BufReader::with_capacity(1, Cursor::new(bytes.as_bytes()));
    let mut reader = CommandReader::default();
    assert!(
        matches!(reader.read(&mut source).unwrap(), Some(Command::Open { text, .. }) if text == "界🌍")
    );
    assert_eq!(
        reader.read(&mut source).unwrap(),
        Some(Command::Close { id: 2 })
    );
    assert_eq!(reader.read(&mut source).unwrap(), None);
}

#[test]
fn invalid_frames_poison_the_reader() {
    for bytes in [
        b"\n".as_slice(),
        b"{}\n",
        b"\xff\n",
        b"\xef\xbb\xbf{}\n",
        b"null\n",
        b"{\"id\":1,\"type\":\"close\"} junk\n",
        b"{\"id\":1,\"type\":\"close\"}",
    ] {
        let mut source = Cursor::new(bytes);
        let mut reader = CommandReader::default();
        assert!(reader.read(&mut source).is_err(), "accepted {bytes:?}");
        assert!(matches!(
            reader.read(&mut source),
            Err(ProtocolError::Poisoned)
        ));
    }
}

#[test]
fn oversized_unterminated_frame_is_rejected_without_reading_to_eof() {
    let mut source = Cursor::new(vec![b' '; MAX_FRAME_BYTES + 1]);
    assert!(matches!(
        CommandReader::default().read(&mut source),
        Err(ProtocolError::Oversized)
    ));
    assert_eq!(source.position(), 0);
}

#[test]
fn exact_frame_limit_is_accepted() {
    let command = br#"{"id":1,"type":"close"}"#;
    let mut bytes = command.to_vec();
    bytes.resize(MAX_FRAME_BYTES, b' ');
    bytes.push(b'\n');
    assert_eq!(read(&bytes).unwrap(), Some(Command::Close { id: 1 }));
}

#[test]
fn malformed_commands_are_rejected() {
    for json in [
        r#"{"id":0,"type":"close"}"#,
        r#"{"id":9007199254740992,"type":"close"}"#,
        r#"{"id":1.5,"type":"close"}"#,
        r#"{"id":-1,"type":"close"}"#,
        r#"{"id":1,"type":"close","unexpected":true}"#,
        r#"{"id":1,"type":"update"}"#,
        r#"{"id":1,"type":"update","text":null}"#,
        r#"{"id":1,"type":"open","title":"bad\nname","text":"","input":""}"#,
        r#"{"id":1,"type":"open","title":"","text":"","input":""}"#,
        r#"{"id":1,"type":"update","input":"\u0000"}"#,
    ] {
        assert!(
            read(format!("{json}\n").as_bytes()).is_err(),
            "accepted {json}"
        );
    }
}

#[test]
fn eof_is_terminal_for_this_channel() {
    let mut reader = CommandReader::default();
    assert_eq!(reader.read(&mut Cursor::new(b"")).unwrap(), None);
    assert_eq!(
        reader
            .read(&mut Cursor::new(b"{\"id\":1,\"type\":\"close\"}\n"))
            .unwrap(),
        None
    );
}

#[test]
fn text_limits_count_utf8_bytes() {
    let command = Command::Update {
        id: 1,
        text: Some("界".repeat(MAX_TEXT_BYTES / 3 + 1)),
        input: None,
    };
    assert!(command.validate().is_err());
    let command = Command::Update {
        id: 1,
        text: Some("a".repeat(MAX_TEXT_BYTES)),
        input: Some(String::new()),
    };
    assert!(command.validate().is_ok());
}

#[test]
fn events_round_trip_with_single_newline_and_escaped_text() {
    let event = Event::Input {
        value: "line 1\nline 2 🌍".into(),
    };
    let mut bytes = Vec::new();
    write_event(&mut bytes, &event).unwrap();
    assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
    assert_eq!(serde_json::from_slice::<Event>(&bytes).unwrap(), event);
}

#[test]
fn absent_error_id_is_not_null() {
    let event = Event::Error {
        id: None,
        code: ErrorCode::InvalidState,
        message: "hello required".into(),
    };
    let mut bytes = Vec::new();
    write_event(&mut bytes, &event).unwrap();
    assert_eq!(
        String::from_utf8(bytes).unwrap(),
        "{\"type\":\"error\",\"code\":\"invalid_state\",\"message\":\"hello required\"}\n"
    );
}
