use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

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
        startup_started: enabled.then(Instant::now),
        startup_records: 0,
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
