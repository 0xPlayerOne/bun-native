//! Bounded native -> Bun FIFO. Reservations include a writer-owned frame until
//! the actual write/flush settles, not merely until it leaves the channel.
use serde::Serialize;
use serde_json::Value;
use std::{
    io::{self, Write},
    sync::{
        mpsc::{sync_channel, Receiver, SyncSender},
        Arc, Mutex,
    },
};

pub const FRAME_BYTES: usize = 65_536;
const CONTROL_BYTES: usize = 1024;
const RECORDS: usize = 256;
const ORDINARY_RECORDS: usize = 192;
// All 128 admitted 24-KiB renderer packets must fit after hex expansion plus
// envelopes; outbound admission must not undercut the existing incoming pool.
const WIRE_BYTES: usize = 8 * 1024 * 1024;
const ORDINARY_WIRE_BYTES: usize = 7 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum AdmissionError {
    InvalidFrame,
    Capacity,
    Unavailable,
}

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub frames: usize,
    pub ordinary_frames: usize,
    pub retained_wire_bytes: usize,
    pub ordinary_wire_bytes: usize,
    pub peak_frames: usize,
    pub peak_wire_bytes: usize,
}
#[derive(Default)]
struct Budget {
    state: Mutex<Snapshot>,
}
struct Permit {
    budget: Arc<Budget>,
    bytes: usize,
    ordinary: bool,
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self
            .budget
            .state
            .lock()
            .expect("Native output budget poisoned");
        state.frames -= 1;
        state.retained_wire_bytes -= self.bytes;
        if self.ordinary {
            state.ordinary_frames -= 1;
            state.ordinary_wire_bytes -= self.bytes;
        }
    }
}

/// Counts emitted JSON bytes without allocating an encoded copy on CEF's thread.
/// The serializer stops at the existing private-pipe frame limit, including LF.
struct Counter(usize);
impl Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > FRAME_BYTES - 1 - self.0 {
            return Err(io::Error::other("Native output frame exceeds limit"));
        }
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
// serde_json scans a complete unescaped string before handing its fragment to
// Write. Check raw string/key lengths and bounded tree structure first, so the
// counting writer is not asked to traverse an arbitrary-sized native value.
fn charge(remaining: &mut usize, bytes: usize) -> Result<(), AdmissionError> {
    if bytes > *remaining {
        return Err(AdmissionError::InvalidFrame);
    }
    *remaining -= bytes;
    Ok(())
}
fn bounded_shape(value: &Value, remaining: &mut usize, depth: usize) -> Result<(), AdmissionError> {
    if depth > 128 {
        return Err(AdmissionError::InvalidFrame);
    }
    match value {
        Value::Null => charge(remaining, 4),
        Value::Bool(value) => charge(remaining, if *value { 4 } else { 5 }),
        // Exact numeric spelling and escaping are still measured by serde_json.
        Value::Number(_) => charge(remaining, 1),
        Value::String(value) => {
            charge(remaining, 2)?;
            charge(remaining, value.len())
        }
        Value::Array(values) => {
            charge(remaining, 2)?;
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    charge(remaining, 1)?;
                }
                bounded_shape(value, remaining, depth + 1)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            charge(remaining, 2)?;
            for (index, (key, value)) in values.iter().enumerate() {
                if index != 0 {
                    charge(remaining, 1)?;
                }
                charge(remaining, 3)?; // Key quotes and colon.
                charge(remaining, key.len())?;
                bounded_shape(value, remaining, depth + 1)?;
            }
            Ok(())
        }
    }
}
fn wire_bytes(value: &Value) -> Result<usize, AdmissionError> {
    bounded_shape(value, &mut (FRAME_BYTES - 1), 0)?;
    let mut count = Counter(0);
    serde_json::to_writer(&mut count, value).map_err(|_| AdmissionError::InvalidFrame)?;
    Ok(count.0 + 1)
}
fn control(value: &Value, bytes: usize) -> bool {
    if bytes > CONTROL_BYTES || value.get("v").and_then(Value::as_u64) != Some(1) {
        return false;
    }
    let Some(object) = value.as_object() else {
        return false;
    };
    if let Some(event) = value.get("event").and_then(Value::as_str) {
        if event == "shutdown" {
            return object.len() == 2
                || (object.len() == 3
                    && value
                        .get("data")
                        .and_then(Value::as_object)
                        .is_some_and(|data| {
                            data.len() == 1 && data.get("failed").is_some_and(Value::is_boolean)
                        }));
        }
        if event == "app.quitting" {
            return object.len() == 3
                && value
                    .get("data")
                    .and_then(Value::as_object)
                    .is_some_and(|data| {
                        data.len() == 1
                            && matches!(
                                data.get("reason").and_then(Value::as_str),
                                Some("requested" | "last-window" | "native" | "failure")
                            )
                    });
        }
        if event == "ready" {
            return object.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "v" | "event" | "abi" | "cef" | "host" | "data"
                )
            }) && value.get("abi").and_then(Value::as_u64) == Some(1);
        }
        return matches!(
            event,
            "rpc.revoked"
                | "stream.revoked"
                | "view.closed"
                | "window.closed"
                | "view.renderer-exit"
        ) && object
            .keys()
            .all(|key| matches!(key.as_str(), "v" | "event" | "target" | "data"))
            && value
                .get("target")
                .and_then(Value::as_u64)
                .is_some_and(|id| (1..=9_007_199_254_740_991).contains(&id));
    }
    // Small command responses retain room to release request ownership. Large
    // responses and arbitrary extra fields remain ordinary; this grants no authority.
    if object.len() != 4
        || !value
            .get("id")
            .and_then(Value::as_u64)
            .is_some_and(|id| (1..=9_007_199_254_740_991).contains(&id))
    {
        return false;
    }
    match value.get("ok").and_then(Value::as_bool) {
        Some(true) => object.contains_key("value"),
        Some(false) => value
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty()),
        None => false,
    }
}

pub struct EventFrame {
    value: Value,
    permit: Permit,
}
struct Encoded {
    bytes: Vec<u8>,
    json_limit: usize,
}
impl Write for Encoded {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.json_limit - self.bytes.len() {
            return Err(io::Error::other("Native output encoding changed size"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl EventFrame {
    /// Serialization allocation and blocking I/O stay on the existing writer.
    /// Consuming self releases the permit only after success, failure or unwind.
    pub fn write_to(self, output: &mut impl Write) -> io::Result<()> {
        let mut encoded = Encoded {
            bytes: Vec::with_capacity(self.permit.bytes),
            json_limit: self.permit.bytes - 1,
        };
        serde_json::to_writer(&mut encoded, &self.value)?;
        if encoded.bytes.len() != encoded.json_limit {
            return Err(io::Error::other("Native output encoding changed size"));
        }
        encoded.bytes.push(b'\n');
        output.write_all(&encoded.bytes)?;
        output.flush()
    }
}
/// Read-only accounting survives sender closure without keeping the queue open.
#[derive(Clone)]
pub struct EventMonitor(Arc<Budget>);
impl EventMonitor {
    pub fn snapshot(&self) -> Snapshot {
        *self.0.state.lock().expect("Native output budget poisoned")
    }
}
#[derive(Clone)]
pub struct EventSender {
    sender: SyncSender<EventFrame>,
    budget: Arc<Budget>,
}
pub fn channel() -> (EventSender, Receiver<EventFrame>) {
    let (sender, receiver) = sync_channel(RECORDS);
    (
        EventSender {
            sender,
            budget: Arc::new(Budget::default()),
        },
        receiver,
    )
}
impl EventSender {
    pub fn monitor(&self) -> EventMonitor {
        EventMonitor(self.budget.clone())
    }
    pub fn try_send(&self, value: Value) -> Result<(), AdmissionError> {
        let bytes = wire_bytes(&value)?;
        let ordinary = !control(&value, bytes);
        {
            let mut state = self
                .budget
                .state
                .lock()
                .map_err(|_| AdmissionError::Unavailable)?;
            if state.frames >= RECORDS
                || bytes > WIRE_BYTES - state.retained_wire_bytes
                || (ordinary
                    && (state.ordinary_frames >= ORDINARY_RECORDS
                        || bytes > ORDINARY_WIRE_BYTES - state.ordinary_wire_bytes))
            {
                return Err(AdmissionError::Capacity);
            }
            state.frames += 1;
            state.retained_wire_bytes += bytes;
            if ordinary {
                state.ordinary_frames += 1;
                state.ordinary_wire_bytes += bytes;
            }
            state.peak_frames = state.peak_frames.max(state.frames);
            state.peak_wire_bytes = state.peak_wire_bytes.max(state.retained_wire_bytes);
        }
        let frame = EventFrame {
            value,
            permit: Permit {
                budget: self.budget.clone(),
                bytes,
                ordinary,
            },
        };
        // Failed posts own and drop the frame/permit too. No detached reservation.
        self.sender
            .try_send(frame)
            .map_err(|_| AdmissionError::Unavailable)
    }
    #[cfg(test)]
    pub fn snapshot(&self) -> Snapshot {
        self.monitor().snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;
    use std::time::Duration;

    fn ordinary(id: usize) -> Value {
        json!({"v":1,"event":"rpc.packet","target":1,"data":{"sequence":id}})
    }
    fn response(id: usize) -> Value {
        json!({"v":1,"id":id,"ok":true,"value":null})
    }
    fn empty(sender: &EventSender) {
        let state = sender.snapshot();
        assert_eq!(state.frames, 0);
        assert_eq!(state.ordinary_frames, 0);
        assert_eq!(state.retained_wire_bytes, 0);
        assert_eq!(state.ordinary_wire_bytes, 0);
    }
    fn sized(bytes: usize) -> Value {
        let mut value = json!({"v":1,"event":"rpc.packet","target":1,"data":{"packet":""}});
        let overhead = wire_bytes(&value).unwrap();
        value["data"]["packet"] = Value::String("x".repeat(bytes - overhead));
        value
    }
    #[test]
    fn excessive_nesting_is_rejected_before_serialization_and_admission() {
        let (tx, rx) = channel();
        let mut value = Value::Null;
        for _ in 0..129 {
            value = Value::Array(vec![value]);
        }
        assert_eq!(tx.try_send(value), Err(AdmissionError::InvalidFrame));
        assert!(rx.try_recv().is_err());
        empty(&tx);
    }
    #[test]
    fn raw_string_key_and_wide_tree_limits_precede_library_encoding() {
        let large = Value::String("x".repeat(8 * 1024 * 1024));
        let mut remaining = FRAME_BYTES - 1;
        assert_eq!(
            bounded_shape(&large, &mut remaining, 0),
            Err(AdmissionError::InvalidFrame)
        );
        assert_eq!(remaining, FRAME_BYTES - 3); // Only quotes charged, no string traversal.
        let mut object = serde_json::Map::new();
        object.insert("k".repeat(FRAME_BYTES), Value::Null);
        assert_eq!(
            wire_bytes(&Value::Object(object)),
            Err(AdmissionError::InvalidFrame)
        );
        let wide = Value::Array(vec![Value::Null; FRAME_BYTES]);
        let mut remaining = FRAME_BYTES - 1;
        assert_eq!(
            bounded_shape(&wide, &mut remaining, 0),
            Err(AdmissionError::InvalidFrame)
        );
        assert!(remaining < 5);
        let mut depth = Value::Null;
        for _ in 0..128 {
            depth = Value::Array(vec![depth]);
        }
        assert_eq!(wire_bytes(&depth).unwrap(), 261);
    }
    #[test]
    fn exact_library_count_is_preserved_for_mixed_values_and_control_characters() {
        let alphabet: String = (0..=255)
            .map(|value| char::from_u32(value).unwrap())
            .collect();
        for repeats in 0..32 {
            let value = json!({"\u{0}key\n": [Value::Null, json!(true), json!(false),
                json!(-42), json!(1.25), json!(f64::MAX),
                json!({"text": alphabet.repeat(repeats)})]});
            assert_eq!(
                wire_bytes(&value).unwrap(),
                serde_json::to_vec(&value).unwrap().len() + 1
            );
        }
    }
    #[test]
    fn exact_json_encoding_includes_escaping_unicode_and_newline() {
        let (tx, rx) = channel();
        let value = json!({"v":1,"event":"view.console","data":{"message":"\u{0}\n\"café-🐙"}});
        let mut expected = serde_json::to_vec(&value).unwrap();
        expected.push(b'\n');
        tx.try_send(value).unwrap();
        assert_eq!(tx.snapshot().retained_wire_bytes, expected.len());
        let frame = rx.recv().unwrap();
        assert_eq!(tx.snapshot().frames, 1);
        let mut actual = Vec::new();
        frame.write_to(&mut actual).unwrap();
        assert_eq!(actual, expected);
        empty(&tx);
    }
    #[test]
    fn maximum_frame_is_admitted_but_excess_rejects_before_queue_growth() {
        let (tx, rx) = channel();
        tx.try_send(sized(FRAME_BYTES)).unwrap();
        let before = tx.snapshot();
        assert_eq!(
            tx.try_send(sized(FRAME_BYTES + 1)),
            Err(AdmissionError::InvalidFrame)
        );
        assert_eq!(tx.snapshot(), before);
        let mut bytes = Vec::new();
        rx.recv().unwrap().write_to(&mut bytes).unwrap();
        assert_eq!(bytes.len(), FRAME_BYTES);
        assert_eq!(bytes.last(), Some(&b'\n'));
        empty(&tx);
    }
    #[test]
    fn saturated_data_preserves_response_lifecycle_and_shutdown_capacity_in_fifo_order() {
        let (tx, rx) = channel();
        for id in 0..ORDINARY_RECORDS {
            tx.try_send(ordinary(id)).unwrap();
        }
        assert_eq!(tx.try_send(ordinary(193)), Err(AdmissionError::Capacity));
        for id in 1..64 {
            tx.try_send(response(id)).unwrap();
        }
        tx.try_send(json!({"v":1,"event":"shutdown"})).unwrap();
        assert_eq!(tx.snapshot().frames, RECORDS);
        assert_eq!(tx.try_send(response(64)), Err(AdmissionError::Capacity));
        for id in 0..ORDINARY_RECORDS {
            let frame = rx.recv().unwrap();
            assert_eq!(frame.value, ordinary(id));
            drop(frame);
        }
        for id in 1..64 {
            assert_eq!(rx.recv().unwrap().value, response(id));
        }
        assert_eq!(rx.recv().unwrap().value["event"], "shutdown");
        empty(&tx);
    }
    #[test]
    fn byte_saturation_keeps_control_headroom_and_never_releases_on_dequeue() {
        let (tx, rx) = channel();
        for _ in 0..112 {
            tx.try_send(sized(FRAME_BYTES)).unwrap();
        }
        assert_eq!(tx.snapshot().ordinary_wire_bytes, ORDINARY_WIRE_BYTES);
        assert_eq!(tx.try_send(ordinary(1)), Err(AdmissionError::Capacity));
        let active = rx.recv().unwrap();
        assert_eq!(tx.snapshot().frames, 112);
        assert_eq!(tx.try_send(ordinary(1)), Err(AdmissionError::Capacity));
        tx.try_send(json!({"v":1,"event":"view.closed","target":1,"data":null}))
            .unwrap();
        assert_eq!(tx.snapshot().frames, 113);
        drop(rx); // Discarded queued frames release, not the blocked writer's frame.
        assert_eq!(tx.snapshot().frames, 1);
        assert_eq!(tx.snapshot().retained_wire_bytes, FRAME_BYTES);
        drop(active);
        empty(&tx);
    }
    #[test]
    fn only_exact_small_native_control_shapes_borrow_headroom() {
        let (tx, rx) = channel();
        for id in 0..ORDINARY_RECORDS {
            tx.try_send(ordinary(id)).unwrap();
        }
        for denied in [
            json!({"v":1,"event":"shutdown","priority":"control"}),
            json!({"v":1,"event":"shutdown.extra"}),
            json!({"v":1,"event":"shutdown","data":{"failed":"false"}}),
            json!({"v":1,"event":"shutdown","data":{"failed":false,"extra":true}}),
            json!({"v":1,"event":"app.quitting","data":{"reason":"unknown"}}),
            json!({"v":1,"event":"app.quitting","target":1,"data":{"reason":"native"}}),
            json!({"v":1,"event":"view.closed","target":0}),
            json!({"v":1,"id":0,"ok":true,"value":null}),
            json!({"v":1,"id":1,"ok":true,"value":"x".repeat(CONTROL_BYTES)}),
            json!({"v":1,"event":"rpc.packet","priority":"control"}),
        ] {
            assert_eq!(tx.try_send(denied), Err(AdmissionError::Capacity));
        }
        for accepted in [
            json!({"v":1,"event":"ready","abi":1,"data":{}}),
            json!({"v":1,"event":"shutdown","data":{"failed":false}}),
            json!({"v":1,"event":"app.quitting","data":{"reason":"native"}}),
            json!({"v":1,"event":"rpc.revoked","target":1,"data":{"connection":1}}),
            json!({"v":1,"event":"stream.revoked","target":1,"data":{"connection":1}}),
            json!({"v":1,"event":"view.closed","target":1,"data":null}),
            json!({"v":1,"event":"window.closed","target":1,"data":null}),
            json!({"v":1,"event":"view.renderer-exit","target":1,"data":{"code":9}}),
            json!({"v":1,"id":1,"ok":false,"error":"unavailable"}),
        ] {
            tx.try_send(accepted).unwrap();
        }
        assert_eq!(tx.snapshot().ordinary_frames, ORDINARY_RECORDS);
        drop(rx);
        empty(&tx);
    }
    #[test]
    fn disconnected_queue_and_short_or_failed_writer_release_exactly_once() {
        let (tx, rx) = channel();
        tx.try_send(ordinary(1)).unwrap();
        let frame = rx.recv().unwrap();
        struct Short(Vec<u8>);
        impl Write for Short {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                let n = bytes.len().min(3);
                self.0.extend_from_slice(&bytes[..n]);
                Ok(n)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut short = Short(Vec::new());
        frame.write_to(&mut short).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&short.0).unwrap(),
            ordinary(1)
        );
        empty(&tx);
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        tx.try_send(ordinary(2)).unwrap();
        assert!(rx.recv().unwrap().write_to(&mut Broken).is_err());
        empty(&tx);
        drop(rx);
        for _ in 0..100 {
            assert_eq!(tx.try_send(response(1)), Err(AdmissionError::Unavailable));
        }
        empty(&tx);
    }
    #[test]
    fn active_flush_holds_reservation_until_the_actual_writer_settles() {
        let (tx, rx) = channel();
        tx.try_send(ordinary(1)).unwrap();
        let bytes = tx.snapshot().retained_wire_bytes;
        let frame = rx.recv().unwrap();
        let (started, start) = mpsc::channel();
        let (release, released) = mpsc::channel();
        struct Held {
            started: mpsc::Sender<()>,
            released: mpsc::Receiver<()>,
        }
        impl Write for Held {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                self.started.send(()).unwrap();
                self.released
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(io::Error::other)
            }
        }
        let worker = std::thread::spawn(move || frame.write_to(&mut Held { started, released }));
        start.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(tx.snapshot().retained_wire_bytes, bytes);
        drop(rx);
        assert_eq!(tx.snapshot().frames, 1);
        release.send(()).unwrap();
        worker.join().unwrap().unwrap();
        empty(&tx);
    }
    #[test]
    fn complete_existing_renderer_packet_pool_fits_after_hex_expansion() {
        let (tx, rx) = channel();
        let packet = "ff".repeat(crate::rpc_authority::MAX_PACKET_BYTES);
        for connection in 1..=crate::rpc_authority::MAX_GLOBAL_PACKETS {
            tx.try_send(json!({"v":1,"event":"rpc.packet","target":connection,
                "data":{"connection":connection,"context":1,"generation":1,
                "sequence":1,"packet":packet,"copiedBytes":crate::rpc_authority::MAX_PACKET_BYTES}})).unwrap();
        }
        assert_eq!(
            tx.snapshot().ordinary_frames,
            crate::rpc_authority::MAX_GLOBAL_PACKETS
        );
        assert!(tx.snapshot().ordinary_wire_bytes > 2 * crate::rpc_authority::MAX_GLOBAL_BYTES);
        tx.try_send(json!({"v":1,"event":"shutdown"})).unwrap();
        drop(rx);
        empty(&tx);
    }
    #[test]
    fn monitor_retains_active_ownership_after_every_sender_closes() {
        let (tx, rx) = channel();
        let monitor = tx.monitor();
        tx.try_send(ordinary(1)).unwrap();
        let active = rx.recv().unwrap();
        drop(tx);
        assert!(rx.recv().is_err());
        drop(rx);
        assert_eq!(monitor.snapshot().frames, 1);
        drop(active);
        assert_eq!(monitor.snapshot().frames, 0);
        assert_eq!(monitor.snapshot().retained_wire_bytes, 0);
    }
    #[test]
    fn concurrent_producers_share_one_atomic_budget() {
        let (tx, rx) = channel();
        for id in 0..ORDINARY_RECORDS {
            tx.try_send(ordinary(id)).unwrap();
        }
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let tx = tx.clone();
                std::thread::spawn(move || {
                    for id in 1..=8 {
                        tx.try_send(response(id)).unwrap();
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(tx.snapshot().frames, 256);
        assert_eq!(tx.try_send(response(1)), Err(AdmissionError::Capacity));
        drop(rx);
        empty(&tx);
    }
}
