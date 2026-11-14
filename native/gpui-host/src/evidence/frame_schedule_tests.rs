use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

#[test]
fn startup_phases_are_opt_in_correlated_and_share_the_budget() {
    let (disabled_file, disabled) = make_log(false);
    disabled.startup_phase("host_evidence_ready", None);
    assert!(std::fs::read(&disabled_file.0).unwrap().is_empty());
    let (file, enabled) = make_log(true);
    enabled.startup_phase("host_evidence_ready", None);
    enabled.startup_phase("hello_dispatched", Some(RequestId::try_from(1).unwrap()));
    let records = rows(&file);
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["phase"], "host_evidence_ready");
    assert!(records[0]["request_id"].is_null());
    assert_eq!(records[1]["request_id"], 1);
    assert_eq!(records[1]["stage"], "startup-diagnostic");
    assert_eq!(records[1]["source"], "native");
    assert_eq!(records[1]["index"], 2);
}

pub(super) struct TemporaryLog(pub(super) PathBuf);

impl Drop for TemporaryLog {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(super) fn make_log(enabled: bool) -> (TemporaryLog, Evidence) {
    let path = std::env::temp_dir().join(format!(
        "bun-native-frame-test-{}-{}.jsonl",
        std::process::id(),
        NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    ));
    let file = OpenOptions::new()
        .create_new(true)
        .append(true)
        .open(&path)
        .unwrap();
    let log = Log {
        file,
        nonce: "frame-schedule-test".into(),
        last_state: BTreeMap::new(),
        last_layout: BTreeMap::new(),
        pointer: None,
        frames: None,
        input_viewports: false,
        startup_started: enabled.then(Instant::now),
        startup_records: 0,
        presentation_records: 0,
        started: Instant::now(),
    };
    (
        TemporaryLog(path),
        Evidence(Some(Rc::new(RefCell::new(log)))),
    )
}

#[test]
fn scheduling_records_require_explicit_trace_and_do_not_claim_paint() {
    let (disabled_file, disabled) = make_log(false);
    let window = WindowId::try_from(1).unwrap();
    disabled.frame_schedule("layer_invalidated", window, 2);
    assert!(std::fs::read(&disabled_file.0).unwrap().is_empty());
    let (enabled_file, enabled) = make_log(true);
    enabled.frame_schedule("layer_invalidated", window, 2);
    enabled.frame_schedule("layer_invalidated", window, 3);
    let text = std::fs::read_to_string(&enabled_file.0).unwrap();
    let rows: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["phase"], "layer_invalidated");
    assert_eq!(rows[1]["phase"], "layer_invalidated");
    for (index, record) in rows.iter().enumerate() {
        assert_eq!(record["index"], index + 1);
        assert_eq!(record["type"], "frame_schedule");
        assert_eq!(record["stage"], "native-frame-scheduling");
        assert_eq!(record["window_id"], 1);
        assert_eq!(record["requested_tree_revision"], index + 2);
        assert!(record.get("nodes").is_none());
    }
}

#[test]
fn scheduling_records_share_one_bounded_budget_across_clones_and_windows() {
    let (file, evidence) = make_log(true);
    let other = evidence.clone();
    for index in 0..u64::from(MAX_STARTUP_RECORDS) + 8 {
        let reporter = if index % 2 == 0 { &evidence } else { &other };
        reporter.frame_schedule(
            "layer_invalidated",
            WindowId::try_from(index + 1).unwrap(),
            index,
        );
    }
    let text = std::fs::read_to_string(&file.0).unwrap();
    let rows: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), usize::from(MAX_STARTUP_RECORDS));
    assert_eq!(rows.last().unwrap()["phase"], "record_limit");
    assert_eq!(rows.last().unwrap()["index"], MAX_STARTUP_RECORDS);
    assert!(text.len() < usize::from(MAX_STARTUP_RECORDS) * 1024);
}

fn rows(file: &TemporaryLog) -> Vec<Value> {
    std::fs::read_to_string(&file.0)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn presentation_records_require_explicit_trace_and_name_the_painted_state() {
    let window = WindowId::try_from(1).unwrap();
    let tree = Tree::new(NodeId::try_from(1).unwrap());
    let native = json!({"presents_with_transaction": true, "needs_display": false});
    let (disabled_file, disabled) = make_log(false);
    assert!(!disabled.presentation_tracing());
    disabled.presentation("painted", window, &tree, native.clone());
    assert!(rows(&disabled_file).is_empty());

    let (file, evidence) = make_log(true);
    assert!(evidence.presentation_tracing());
    evidence.presentation("layer_invalidated", window, &tree, native.clone());
    evidence.presentation("painted", window, &tree, native.clone());
    let written = rows(&file);
    assert_eq!(written.len(), 2);
    for (index, (record, phase)) in written
        .iter()
        .zip(["layer_invalidated", "painted"])
        .enumerate()
    {
        assert_eq!(record["type"], "presentation");
        assert_eq!(record["stage"], "native-presentation");
        assert_eq!(record["clock"], "process_monotonic_relative");
        assert_eq!(record["phase"], phase);
        assert_eq!(record["index"], index + 1);
        assert_eq!(record["window_id"], 1);
        assert_eq!(record["tree_revision"], tree.revision());
        assert_eq!(record["input_revisions"], json!([]));
        assert_eq!(record["native"], native);
        assert!(record.get("nodes").is_none());
    }
    // Presentation records keep their own budget: scheduling still records.
    evidence.frame_schedule("layer_invalidated", window, 1);
    assert_eq!(rows(&file)[2]["index"], 1);
}

#[test]
fn presentation_records_are_bounded_with_a_visible_limit() {
    let window = WindowId::try_from(1).unwrap();
    let tree = Tree::new(NodeId::try_from(1).unwrap());
    let (file, evidence) = make_log(true);
    for _ in 0..u32::from(MAX_PRESENTATION_RECORDS) + 8 {
        evidence.presentation("painted", window, &tree, json!({}));
    }
    assert!(!evidence.presentation_tracing());
    let written = rows(&file);
    assert_eq!(written.len(), usize::from(MAX_PRESENTATION_RECORDS));
    let last = written.last().unwrap();
    assert_eq!(last["phase"], "record_limit");
    assert_eq!(last["index"], MAX_PRESENTATION_RECORDS);
    assert!(last.get("native").is_none());
}
