use super::*;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

#[derive(Clone, Default)]
struct Sink {
    bytes: Rc<RefCell<Vec<u8>>>,
    writes: Rc<Cell<usize>>,
    fail: bool,
}

impl Write for Sink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.writes.set(self.writes.get() + 1);
        if self.fail {
            return Err(io::Error::other("deliberate diagnostic I/O failure"));
        }
        self.bytes.borrow_mut().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn records(sink: &Sink) -> Vec<Value> {
    let bytes = sink.bytes.borrow();
    assert!(bytes.len() <= MAX_TOTAL_BYTES);
    std::str::from_utf8(&bytes)
        .unwrap()
        .lines()
        .enumerate()
        .map(|(index, line)| {
            assert!(line.len() < MAX_RECORD_BYTES);
            let record: Value = serde_json::from_str(line).unwrap();
            assert_eq!(record["index"], index + 1);
            assert_eq!(record["stage"], "startup-log");
            assert_eq!(record["source"], "native-log");
            assert_eq!(record["nonce"], "test-nonce");
            record
        })
        .collect()
}

fn send(output: &mut Output<Sink>, message: &str) -> io::Result<()> {
    output.record(
        &Record::builder()
            .args(format_args!("{message}"))
            .target(TARGETS[0])
            .level(Level::Info)
            .line(Some(496))
            .build(),
    )
}

#[test]
fn requires_explicit_flags_absolute_path_and_valid_nonce() {
    let path = std::env::temp_dir().join("bun-native-startup-log.jsonl");
    let path = path.to_str().unwrap();
    assert!(Configuration::parse("1", "1", path, "nonce").is_some());
    for (flag, trace, path, nonce) in [
        ("", "1", path, "nonce"),
        ("true", "1", path, "nonce"),
        ("1", "", path, "nonce"),
        ("1", "1", "relative.jsonl", "nonce"),
        ("1", "1", path, ""),
        ("1", "1", path, "bad\nnonce"),
    ] {
        assert!(Configuration::parse(flag, trace, path, nonce).is_none());
    }
    assert!(Configuration::parse("1", "1", path, &"é".repeat(65)).is_none());
}

#[test]
fn exact_targets_and_level_filter_before_formatting() {
    struct Unreachable;
    impl fmt::Display for Unreachable {
        fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
            panic!("filtered message must not be formatted");
        }
    }
    let sink = Sink::default();
    let mut output = Output::new(sink.clone(), "test-nonce".into());
    for (target, level) in [
        ("gpui_linux::linux::x11::window::other", Level::Info),
        ("gpui_linux::linux::x11", Level::Error),
        ("unrelated", Level::Error),
        (TARGETS[0], Level::Debug),
        (TARGETS[1], Level::Trace),
    ] {
        output
            .record(
                &Record::builder()
                    .args(format_args!("{}", Unreachable))
                    .target(target)
                    .level(level)
                    .build(),
            )
            .unwrap();
    }
    assert_eq!(sink.writes.get(), 0);
    for target in TARGETS {
        for level in [Level::Error, Level::Warn, Level::Info] {
            assert!(allowed(
                &Metadata::builder().target(target).level(level).build()
            ));
        }
    }
    send(&mut output, "Using visual").unwrap();
    let records = records(&sink);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["message"], "Using visual");
    assert_eq!(records[0]["target"], TARGETS[0]);
    assert_eq!(records[0]["line"], 496);
}

#[test]
fn record_cap_includes_a_single_terminal_record_and_stops_writes() {
    let sink = Sink::default();
    let mut output = Output::new(sink.clone(), "test-nonce".into());
    output.emit(json!({"phase": "logger_installed"})).unwrap();
    for _ in 0..MAX_RECORDS * 2 {
        send(&mut output, "GPU adapter").unwrap();
    }
    let records = records(&sink);
    assert_eq!(records.len(), MAX_RECORDS);
    assert_eq!(records.last().unwrap()["phase"], "record_limit");
    assert_eq!(sink.writes.get(), MAX_RECORDS);
    assert!(output.sink.is_none());
}

#[test]
fn total_byte_cap_reserves_a_terminal_record() {
    let sink = Sink::default();
    let mut output = Output::new(sink.clone(), "test-nonce".into());
    for _ in 0..MAX_RECORDS * 2 {
        send(&mut output, &"\"".repeat(MAX_MESSAGE_BYTES)).unwrap();
    }
    let records = records(&sink);
    assert!(records.len() < MAX_RECORDS);
    assert_eq!(records.last().unwrap()["phase"], "byte_limit");
    assert!(output.sink.is_none());
}

#[test]
fn utf8_and_json_expansion_are_bounded_and_visible() {
    let sink = Sink::default();
    let mut output = Output::new(sink.clone(), "test-nonce".into());
    send(&mut output, &"漢🙂".repeat(200)).unwrap();
    send(&mut output, &"\u{1}".repeat(MAX_MESSAGE_BYTES)).unwrap();
    let records = records(&sink);
    let message = records[0]["message"].as_str().unwrap();
    assert!(message.len() <= MAX_MESSAGE_BYTES);
    assert_eq!(records[0]["truncated"], true);
    assert_eq!(records[0]["format_error"], false);
    assert_eq!(
        records[1]["message"],
        "[message omitted: JSON record limit]"
    );
    assert_eq!(records[1]["truncated"], true);
}

#[test]
fn formatting_error_is_reported_without_panicking_or_disabling_output() {
    struct Broken;
    impl fmt::Display for Broken {
        fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
            Err(fmt::Error)
        }
    }
    let sink = Sink::default();
    let mut output = Output::new(sink.clone(), "test-nonce".into());
    output
        .record(
            &Record::builder()
                .args(format_args!("{}", Broken))
                .target(TARGETS[1])
                .level(Level::Warn)
                .build(),
        )
        .unwrap();
    send(&mut output, "next record").unwrap();
    let records = records(&sink);
    assert_eq!(records[0]["format_error"], true);
    assert_eq!(records[0]["truncated"], false);
    assert_eq!(records[1]["message"], "next record");
}

#[test]
fn failed_write_disables_capture_without_repeated_io() {
    let sink = Sink {
        fail: true,
        ..Sink::default()
    };
    let mut output = Output::new(sink.clone(), "test-nonce".into());
    assert!(send(&mut output, "first").is_err());
    assert!(send(&mut output, "second").is_ok());
    assert_eq!(sink.writes.get(), 1);
    assert!(output.sink.is_none());
}
