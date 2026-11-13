//! Opt-in native paint instrumentation. A paint callback is not proof of display
//! presentation; screenshots are separate. Every JSONL record is bounded.

mod frames;
mod layout;
mod pointer;
use bun_native_protocol::{BatchMetrics, MAX_EVENT_FRAME_BYTES, NodeId, RequestId, Tree, WindowId};
pub(crate) use layout::LayoutFrame;
use layout::LayoutSnapshot;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::rc::Rc;
use std::time::Instant;

const MAX_STARTUP_RECORDS: u16 = 256;
/// Presentation records have their own bound, so a long fixture's paints
/// neither exhaust the startup budget nor stop before a late failure.
#[cfg(any(target_os = "macos", test))]
const MAX_PRESENTATION_RECORDS: u16 = 1024;

#[derive(Clone, Default)]
pub(crate) struct Evidence(Option<Rc<RefCell<Log>>>);

type PaintVersion = (u64, Vec<(NodeId, u64)>);
struct Log {
    file: File,
    nonce: String,
    started: Instant,
    last_state: BTreeMap<WindowId, PaintVersion>,
    last_layout: BTreeMap<WindowId, LayoutSnapshot>,
    pointer: Option<pointer::PointerTrace>,
    frames: Option<frames::FrameTrace>,
    input_viewports: bool,
    startup_started: Option<Instant>,
    startup_records: u16,
    #[cfg(any(target_os = "macos", test))]
    presentation_records: u16,
}

fn append(file: &mut File, record: &Value) -> io::Result<()> {
    let mut line = record.to_string();
    if line.len() > MAX_EVENT_FRAME_BYTES {
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
                started: Instant::now(),
                last_state: BTreeMap::new(),
                last_layout: BTreeMap::new(),
                pointer: pointer::PointerTrace::from_environment(),
                frames: frames::FrameTrace::from_environment(),
                input_viewports: std::env::var("BUN_NATIVE_INPUT_VIEWPORT_TRACE").as_deref()
                    == Ok("1"),
                startup_started: (std::env::var("BUN_NATIVE_STARTUP_TRACE").as_deref() == Ok("1"))
                    .then(Instant::now),
                startup_records: 0,
                #[cfg(any(target_os = "macos", test))]
                presentation_records: 0,
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

    pub(crate) fn input_viewport_tracing(&self) -> bool {
        self.0
            .as_ref()
            .is_some_and(|log| log.borrow().input_viewports)
    }

    /// Opt-in phase evidence only; never changes native dispatch or its deadline.
    pub(crate) fn startup(&self, phase: &'static str, id: RequestId, window_id: WindowId) {
        let Some(log) = &self.0 else {
            return;
        };
        let mut log = log.borrow_mut();
        let Some(started) = log.startup_started else {
            return;
        };
        if log.startup_records >= MAX_STARTUP_RECORDS {
            return;
        }
        log.startup_records += 1;
        let phase = if log.startup_records == MAX_STARTUP_RECORDS {
            "record_limit"
        } else {
            phase
        };
        let record = json!({
            "nonce": log.nonce,
            "stage": "startup-diagnostic",
            "source": "native",
            "pid": std::process::id(),
            "clock": "process_monotonic_relative",
            "elapsed_ns": started.elapsed().as_nanos().to_string(),
            "index": log.startup_records,
            "phase": phase,
            "request_id": id,
            "window_id": window_id,
        });
        if let Err(error) = append(&mut log.file, &record) {
            eprintln!("Bun Native startup evidence unavailable: {error}");
            log.startup_started = None;
        }
    }

    /// Bounded scheduling evidence, distinct from actual native-paint records.
    /// Shares the explicit startup-trace opt-in and its process-wide budget.
    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn frame_schedule(
        &self,
        phase: &'static str,
        window_id: WindowId,
        requested_revision: u64,
    ) {
        let Some(log) = &self.0 else {
            return;
        };
        let mut log = log.borrow_mut();
        let Some(started) = log.startup_started else {
            return;
        };
        if log.startup_records >= MAX_STARTUP_RECORDS {
            return;
        }
        log.startup_records += 1;
        let phase = if log.startup_records == MAX_STARTUP_RECORDS {
            "record_limit"
        } else {
            phase
        };
        let record = json!({
            "nonce": log.nonce,
            "type": "frame_schedule",
            "stage": "native-frame-scheduling",
            "clock": "process_monotonic_relative",
            "elapsed_ns": started.elapsed().as_nanos().to_string(),
            "index": log.startup_records,
            "phase": phase,
            "window_id": window_id,
            "requested_tree_revision": requested_revision,
        });
        if append(&mut log.file, &record).is_err() {
            log.startup_started = None;
        }
    }

    /// Whether [`Evidence::presentation`] records anything, so callers can
    /// skip reading native state that would only be discarded.
    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn presentation_tracing(&self) -> bool {
        self.0.as_ref().is_some_and(|log| {
            let log = log.borrow();
            log.startup_started.is_some() && log.presentation_records < MAX_PRESENTATION_RECORDS
        })
    }

    /// One bounded record of the native surface's presentation state at a
    /// paint, a layer invalidation or a key dispatch, on the same process clock
    /// as the scheduling records. It shares their explicit opt-in. A paint
    /// record is not a presentation: `native` says which GPUI path drew it
    /// (see `bun_native_macos_surface::presentation`), so a stale capture can
    /// be matched to the last frame that GPUI actually presented.
    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn presentation(
        &self,
        phase: &'static str,
        window_id: WindowId,
        tree: &Tree,
        native: Value,
    ) {
        let Some(log) = &self.0 else {
            return;
        };
        let mut log = log.borrow_mut();
        let Some(started) = log.startup_started else {
            return;
        };
        if log.presentation_records >= MAX_PRESENTATION_RECORDS {
            return;
        }
        log.presentation_records += 1;
        let mut record = json!({
            "nonce": log.nonce,
            "type": "presentation",
            "stage": "native-presentation",
            "clock": "process_monotonic_relative",
            "elapsed_ns": started.elapsed().as_nanos().to_string(),
            "index": log.presentation_records,
            "window_id": window_id,
        });
        if log.presentation_records == MAX_PRESENTATION_RECORDS {
            record["phase"] = json!("record_limit");
        } else {
            record["phase"] = json!(phase);
            record["tree_revision"] = json!(tree.revision());
            record["input_revisions"] = json!(
                tree.nodes()
                    .filter_map(|(id, node)| node
                        .input_revision()
                        .map(|revision| [id.get(), revision]))
                    .collect::<Vec<_>>()
            );
            record["native"] = native;
        }
        if append(&mut log.file, &record).is_err() {
            log.presentation_records = MAX_PRESENTATION_RECORDS;
        }
    }

    /// [`Evidence::presentation`] with the owned window's native surface state.
    #[cfg(target_os = "macos")]
    pub(crate) fn surface_presentation(
        &self,
        phase: &'static str,
        window_id: WindowId,
        tree: &Tree,
        window: &gpui::Window,
    ) {
        if !self.presentation_tracing() {
            return;
        }
        let state = raw_window_handle::HasWindowHandle::window_handle(window)
            .map_err(|_| "native window handle is unavailable".to_string())
            .and_then(|handle| {
                bun_native_macos_surface::presentation::presentation_state(handle)
                    .map_err(|error| error.to_string())
            });
        let native = match state {
            Ok(state) => json!({
                "presents_with_transaction": state.presents_with_transaction,
                "needs_display": state.needs_display,
                "occlusion_visible": state.occlusion_visible,
                "key_window": state.key_window,
            }),
            Err(reason) => json!({"status": "unavailable", "reason": reason}),
        };
        self.presentation(phase, window_id, tree, native);
    }

    pub(crate) fn renderer(&self, window_id: WindowId, window: &gpui::Window) {
        let Some(log) = &self.0 else {
            return;
        };
        let mut log = log.borrow_mut();
        let record = json!({"nonce":log.nonce,"type":"renderer","window_id":window_id,"gpu":window.gpu_specs()});
        #[cfg(target_os = "macos")]
        let record = {
            let mut record = record;
            let device = raw_window_handle::HasWindowHandle::window_handle(window)
                .map_err(|_| "native window handle is unavailable".to_string())
                .and_then(|handle| {
                    bun_native_macos_surface::metal_device(handle)
                        .map_err(|error| error.to_string())
                });
            record["frame_source"] =
                json!(crate::frame_pacing::chosen().map(|source| source.name()));
            record["metal_device"] = match device {
                Ok(device) => json!({
                    "status": "reported", "source": "CAMetalLayer.device",
                    "device_name": device.name, "registry_id": device.registry_id.to_string(),
                    "is_software_emulated": null, "driver_name": null, "driver_info": null
                }),
                Err(reason) => json!({
                    "status": "unavailable", "source": "CAMetalLayer.device", "reason": reason
                }),
            };
            record
        };
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

    /// GPUI received the window manager's close request (WM_DELETE_WINDOW on
    /// X11) for an owned window. Observation only: the request still closes.
    pub(crate) fn close_requested(&self, window_id: WindowId) {
        if let Some(log) = &self.0 {
            let mut log = log.borrow_mut();
            let record = json!({
                "nonce": log.nonce,
                "type": "native_close_requested",
                "stage": "native-lifecycle",
                "pid": std::process::id(),
                "window_id": window_id,
                "clock": "native_evidence_initialization_relative",
                "elapsed_ns": log.started.elapsed().as_nanos().to_string(),
            });
            if let Err(error) = append(&mut log.file, &record) {
                eprintln!("Bun Native close evidence unavailable: {error}");
            }
        }
    }

    pub(crate) fn closed(&self, window_id: WindowId) {
        if let Some(log) = &self.0 {
            let mut log = log.borrow_mut();
            log.last_state.remove(&window_id);
            log.last_layout.remove(&window_id);
            if let Some(trace) = &mut log.pointer {
                trace.closed(window_id);
            }
            // This existing callback observes native removal, not WM delivery
            // or transport receipt. Reuse the bounded optional evidence writer.
            let record = json!({
                "nonce": log.nonce,
                "type": "native_window_closed",
                "stage": "native-lifecycle",
                "pid": std::process::id(),
                "window_id": window_id,
                "clock": "native_evidence_initialization_relative",
                "elapsed_ns": log.started.elapsed().as_nanos().to_string(),
            });
            if let Err(error) = append(&mut log.file, &record) {
                eprintln!("Bun Native close evidence unavailable: {error}");
            }
        }
    }

    /// A new rendered record follows any changed geometry from this paint.
    /// Identical geometry is reused; geometry-only frames still publish layout.
    pub(crate) fn painted(&self, window_id: WindowId, tree: &Tree, layout: Option<LayoutSnapshot>) {
        let Some(log) = &self.0 else {
            return;
        };
        let mut log = log.borrow_mut();
        if log.frames.is_some() {
            return;
        }
        if let Some(snapshot) = layout
            && log.last_layout.get(&window_id) != Some(&snapshot)
        {
            let record = json!({"nonce":log.nonce,"type":"layout","stage":"native-paint","window_id":window_id,"tree_revision":tree.revision(),"layout":snapshot.json()});
            if let Err(error) = append(&mut log.file, &record) {
                eprintln!("Bun Native layout evidence unavailable: {error}");
                // Never certify a new paint against stale geometry after a
                // failed append. Leave both caches eligible for publication.
                return;
            }
            log.last_layout.insert(window_id, snapshot);
        }
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
            if size > MAX_EVENT_FRAME_BYTES {
                omitted = true;
                break;
            }
            nodes.push(value);
        }
        let mut record = json!({"nonce":log.nonce,"type":"rendered","stage":"native-paint","window_id":window_id,"tree_revision":tree.revision()});
        if omitted {
            record["status"] = json!("omitted");
            record["reason"] = json!("evidence_record_limit");
            record["max_record_bytes"] = json!(MAX_EVENT_FRAME_BYTES);
            record["node_count"] = json!(tree.nodes().count());
        } else {
            record["nodes"] = json!(nodes);
        }
        if append(&mut log.file, &record).is_ok() {
            log.last_state.insert(window_id, version);
        }
    }
}

#[cfg(test)]
mod frame_schedule_tests;
