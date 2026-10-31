//! Opt-in native paint instrumentation. A paint callback is not proof of display
//! presentation; screenshots are separate. Every JSONL record is bounded.

mod layout;
use bun_native_protocol::{BatchMetrics, MAX_FRAME_BYTES, NodeId, Tree, WindowId};
pub(crate) use layout::LayoutFrame;
use layout::LayoutSnapshot;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::rc::Rc;

#[derive(Clone, Default)]
pub(crate) struct Evidence(Option<Rc<RefCell<Log>>>);

type PaintVersion = (u64, Vec<(NodeId, u64)>);
struct Log {
    file: File,
    nonce: String,
    last_state: BTreeMap<WindowId, PaintVersion>,
    last_layout: BTreeMap<WindowId, LayoutSnapshot>,
}

fn append(file: &mut File, record: &Value) -> io::Result<()> {
    let mut line = record.to_string();
    if line.len() > MAX_FRAME_BYTES {
        return Err(io::Error::other("evidence record exceeds 65536 bytes"));
    }
    line.push('\n');
    // Bun also appends to this file. Keep each record in one append operation.
    file.write_all(line.as_bytes())?;
    file.flush()
}

impl Evidence {
    pub(crate) fn from_environment() -> Self {
        let (Ok(path), Ok(nonce)) = (
            std::env::var("BUN_NATIVE_EVIDENCE_LOG"),
            std::env::var("BUN_NATIVE_EVIDENCE_NONCE"),
        ) else {
            return Self::default();
        };
        if nonce.is_empty() || nonce.len() > 128 || nonce.chars().any(char::is_control) {
            return Self::default();
        }
        match OpenOptions::new().create(true).append(true).open(path) {
            Ok(file) => Self(Some(Rc::new(RefCell::new(Log {
                file,
                nonce,
                last_state: BTreeMap::new(),
                last_layout: BTreeMap::new(),
            })))),
            Err(error) => {
                eprintln!("Bun Native native evidence log unavailable: {error}");
                Self::default()
            }
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.0.is_some()
    }

    pub(crate) fn layout(
        &self,
        window_id: WindowId,
        revision: u64,
        frame: &LayoutFrame,
        window: &gpui::Window,
    ) {
        let Some(log) = &self.0 else {
            return;
        };
        let snapshot = frame.snapshot(window);
        let mut log = log.borrow_mut();
        if log.last_layout.get(&window_id) == Some(&snapshot) {
            return;
        }
        let record = json!({"nonce":log.nonce,"type":"layout","stage":"native-paint","window_id":window_id,"tree_revision":revision,"layout":snapshot.json()});
        if let Err(error) = append(&mut log.file, &record) {
            eprintln!("Bun Native layout evidence unavailable: {error}");
        } else {
            log.last_layout.insert(window_id, snapshot);
        }
    }

    pub(crate) fn renderer(&self, window_id: WindowId, gpu: Option<gpui::GpuSpecs>) {
        let Some(log) = &self.0 else {
            return;
        };
        let mut log = log.borrow_mut();
        let record = json!({"nonce":log.nonce,"type":"renderer","window_id":window_id,"gpu":gpu});
        if let Err(error) = append(&mut log.file, &record) {
            eprintln!("Bun Native renderer evidence unavailable: {error}");
        }
    }

    pub(crate) fn batch(&self, window_id: WindowId, revision: u64, metrics: &BatchMetrics) {
        let Some(log) = &self.0 else {
            return;
        };
        let mut log = log.borrow_mut();
        let record = json!({"nonce":log.nonce,"type":"batch_applied","window_id":window_id,"tree_revision":revision,
            "operation_count":metrics.operation_count,"node_count":metrics.node_count,"text_bytes":metrics.text_bytes,"preflight_nanos":metrics.preflight_nanos});
        if let Err(error) = append(&mut log.file, &record) {
            eprintln!("Bun Native batch evidence unavailable: {error}");
        }
    }

    pub(crate) fn closed(&self, window_id: WindowId) {
        if let Some(log) = &self.0 {
            let mut log = log.borrow_mut();
            log.last_state.remove(&window_id);
            log.last_layout.remove(&window_id);
        }
    }

    pub(crate) fn painted(&self, window_id: WindowId, tree: &Tree) {
        let Some(log) = &self.0 else {
            return;
        };
        let mut log = log.borrow_mut();
        let version = (
            tree.revision(),
            tree.nodes()
                .filter_map(|(id, node)| node.input_revision().map(|revision| (id, revision)))
                .collect(),
        );
        if log.last_state.get(&window_id) == Some(&version) {
            return;
        }
        let mut nodes = Vec::new();
        let mut size = 1024; // Header/nonce margin, including JSON escaping.
        let mut omitted = false;
        for (node_id, node) in tree.nodes() {
            let mut value =
                json!({"node_id":node_id,"element":node.element(),"children":node.children()});
            if let Some(revision) = node.input_revision() {
                value["input_revision"] = json!(revision);
            }
            size += value.to_string().len() + 1;
            if size > MAX_FRAME_BYTES {
                omitted = true;
                break;
            }
            nodes.push(value);
        }
        let mut record = json!({"nonce":log.nonce,"type":"rendered","stage":"native-paint","window_id":window_id,"tree_revision":tree.revision()});
        if omitted {
            record["status"] = json!("omitted");
            record["reason"] = json!("evidence_record_limit");
            record["max_record_bytes"] = json!(MAX_FRAME_BYTES);
            record["node_count"] = json!(tree.nodes().count());
        } else {
            record["nodes"] = json!(nodes);
        }
        if append(&mut log.file, &record).is_ok() {
            log.last_state.insert(window_id, version);
        }
    }
}
