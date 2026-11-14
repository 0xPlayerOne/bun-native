use crate::wire::safe_integer;
use crate::{
    Command, Event, FileResult, Operation, RequestId, ValidCommand, WindowId,
    MAX_EVENT_FRAME_BYTES, MAX_FRAME_BYTES,
};
use serde::{de, Deserialize, Deserializer};
use std::fmt;
use std::io::{self, BufRead, Write};

#[derive(Debug)]
pub enum ProtocolError {
    Io(io::Error),
    InvalidJson(serde_json::Error),
    InvalidCommand(&'static str),
    InvalidEvent(&'static str),
    Oversized,
    Truncated,
    Poisoned,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "channel I/O failed: {error}"),
            Self::InvalidJson(error) => write!(formatter, "invalid JSON frame: {error}"),
            Self::InvalidCommand(message) | Self::InvalidEvent(message) => {
                formatter.write_str(message)
            }
            Self::Oversized => formatter.write_str("frame exceeds its byte limit"),
            Self::Truncated => formatter.write_str("channel ended within a frame"),
            Self::Poisoned => formatter.write_str("channel is poisoned"),
        }
    }
}

impl std::error::Error for ProtocolError {}

/// Capacity the reader keeps between frames. Nearly every command is far
/// smaller; a larger mount frame borrows memory only while it is decoded.
pub(crate) const RETAINED_FRAME_BYTES: usize = 65_536;

/// Owns at most one bounded frame. Reading cannot grow with an untrusted line.
/// The frame buffer is reused across frames. A longer line is rejected before
/// it is copied, so capacity stays within one frame plus `Vec` growth slack
/// while a frame is read, returns to `RETAINED_FRAME_BYTES` after it, and is
/// released once the reader is poisoned or finished.
#[derive(Default)]
pub struct CommandReader {
    frame: Vec<u8>,
    poisoned: bool,
    finished: bool,
}

impl CommandReader {
    pub fn read(
        &mut self,
        source: &mut impl BufRead,
    ) -> Result<Option<ValidCommand>, ProtocolError> {
        if self.poisoned {
            return Err(ProtocolError::Poisoned);
        }
        if self.finished {
            return Ok(None);
        }
        let result = self.read_inner(source);
        if self.frame.capacity() > RETAINED_FRAME_BYTES {
            self.frame.clear();
            self.frame.shrink_to(RETAINED_FRAME_BYTES);
        }
        if result.is_err() {
            self.poisoned = true;
            self.frame = Vec::new();
        }
        if matches!(result, Ok(None)) {
            self.finished = true;
            self.frame = Vec::new();
        }
        result
    }

    fn read_inner(
        &mut self,
        source: &mut impl BufRead,
    ) -> Result<Option<ValidCommand>, ProtocolError> {
        let frame = &mut self.frame;
        frame.clear();
        loop {
            let available = source.fill_buf().map_err(ProtocolError::Io)?;
            if available.is_empty() {
                return if frame.is_empty() {
                    Ok(None)
                } else {
                    Err(ProtocolError::Truncated)
                };
            }
            let newline = memchr::memchr(b'\n', available);
            let count = newline.unwrap_or(available.len());
            if frame.len() + count > MAX_FRAME_BYTES {
                return Err(ProtocolError::Oversized);
            }
            frame.extend_from_slice(&available[..count]);
            source.consume(count + usize::from(newline.is_some()));
            if newline.is_some() {
                let command = decode_command(frame)?;
                return ValidCommand::new(command)
                    .map(Some)
                    .map_err(ProtocolError::InvalidCommand);
            }
        }
    }
}

/// Decodes one frame with `JSON.parse`'s last-member semantics for duplicate
/// keys, without paying for an intermediate `Value` on ordinary frames.
///
/// The typed decoder rejects every duplicate key it can see: serde's derived
/// struct visitors report `duplicate field`, internal tags report a duplicate
/// tag, and every command type denies unknown fields, so no object is skipped
/// unread. A typed success therefore proves the frame has no duplicate keys,
/// where collapsing through `Value` is the identity and both paths agree. Any
/// typed failure is decided by the reference `Value` path alone, so duplicate
/// keys, error variants and messages are unchanged. Failures poison the reader,
/// so the second parse happens at most once per session.
pub(crate) fn decode_command(frame: &[u8]) -> Result<Command, ProtocolError> {
    if let Some(batch) = decode_batch_frame(frame) {
        return Ok(batch);
    }
    serde_json::from_slice(frame).or_else(|_| decode_command_last_wins(frame))
}

/// The batch command's own members, in a plain struct. `Command` is internally
/// tagged, so decoding a batch through it first copies the whole frame, every
/// operation included, into a buffered tree and then replays it. Batches are
/// nearly all of the bytes the host reads, and the typed path here reads them
/// once. It accepts exactly the objects `Command::Batch` accepts: unknown and
/// duplicate members fail, so no object is skipped unread.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchFrame {
    id: RequestId,
    #[serde(rename = "type", deserialize_with = "batch_tag")]
    _kind: (),
    window_id: WindowId,
    #[serde(deserialize_with = "safe_integer")]
    base_revision: u64,
    operations: Vec<Operation>,
}

/// Only the string `"batch"`. A derived unit variant would also accept its index.
fn batch_tag<'de, D: Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
    struct Tag;
    impl de::Visitor<'_> for Tag {
        type Value = ();
        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("\"batch\"")
        }
        fn visit_str<E: de::Error>(self, value: &str) -> Result<(), E> {
            if value == "batch" {
                Ok(())
            } else {
                Err(E::invalid_value(de::Unexpected::Str(value), &self))
            }
        }
    }
    deserializer.deserialize_str(Tag)
}

/// Decodes a batch frame without the buffered tag path. `None` for any other
/// frame and for any failure, which the general decoder then judges.
fn decode_batch_frame(frame: &[u8]) -> Option<Command> {
    // The runtime writes `id` before `type`; a differently ordered batch just
    // takes the general path.
    const TAG: &[u8] = b"\"type\":\"batch\"";
    let head = &frame[..frame.len().min(64)];
    head.windows(TAG.len())
        .any(|window| window == TAG)
        .then_some(())?;
    let batch: BatchFrame = serde_json::from_slice(frame).ok()?;
    Some(Command::Batch {
        id: batch.id,
        window_id: batch.window_id,
        base_revision: batch.base_revision,
        operations: batch.operations,
    })
}

/// The reference decoder. Parsing rejects invalid UTF-8, BOMs, empty frames
/// and trailing junk; typed conversion then rejects unknown fields and invalid
/// command shapes.
pub(crate) fn decode_command_last_wins(frame: &[u8]) -> Result<Command, ProtocolError> {
    let value: serde_json::Value =
        serde_json::from_slice(frame).map_err(ProtocolError::InvalidJson)?;
    serde_json::from_value(value).map_err(ProtocolError::InvalidJson)
}

/// Writes events through one reused, bounded encode buffer. Never logs on stdout.
#[derive(Default)]
pub struct EventWriter {
    buffer: Vec<u8>,
}

impl EventWriter {
    /// Writes one complete event and flushes before returning.
    pub fn write(&mut self, sink: &mut impl Write, event: &Event) -> Result<(), ProtocolError> {
        event.validate().map_err(ProtocolError::InvalidEvent)?;
        self.buffer.clear();
        let encoded = encode_event(&mut self.buffer, event);
        if encoded.is_err() || self.buffer.len() > MAX_EVENT_FRAME_BYTES {
            // Keep retained capacity bounded by one frame after a rejected event.
            self.buffer.clear();
            self.buffer.shrink_to(MAX_EVENT_FRAME_BYTES + 1);
            encoded.map_err(ProtocolError::InvalidJson)?;
            return Err(ProtocolError::Oversized);
        }
        self.buffer.push(b'\n');
        sink.write_all(&self.buffer).map_err(ProtocolError::Io)?;
        sink.flush().map_err(ProtocolError::Io)
    }
}

/// Encodes an event that passed [`Event::validate`] exactly as
/// `serde_json::to_writer` does.
///
/// Process output and file read events carry up to 21,848 bytes of base64,
/// which serde_json's string escaping scans one byte at a time: about 8% of
/// the host's CPU while it streams process output. Validation has already
/// proved those payloads padded standard base64, and no base64 byte is escaped
/// in JSON, so the event is encoded with an empty payload and the payload is
/// copied between its quotes unchanged.
fn encode_event(buffer: &mut Vec<u8>, event: &Event) -> serde_json::Result<()> {
    const EMPTY: &[u8] = br#""data":"""#;
    let Some((data, hollow)) = hollow_base64(event) else {
        return serde_json::to_writer(buffer, event);
    };
    serde_json::to_writer(&mut *buffer, &hollow)?;
    // Every other member of these events is a number, a boolean or an enum
    // spelling, so the only empty `data` member is the payload's.
    let Some(start) = buffer
        .windows(EMPTY.len())
        .rposition(|window| window == EMPTY)
    else {
        buffer.clear();
        return serde_json::to_writer(buffer, event);
    };
    // Append the payload, then rotate the few bytes after its opening quote
    // behind it.
    let at = start + EMPTY.len() - 1;
    let closing = buffer.len() - at;
    buffer.extend_from_slice(data.as_bytes());
    buffer[at..].rotate_left(closing);
    Ok(())
}

/// A validated event's base64 payload, and the same event with it empty.
fn hollow_base64(event: &Event) -> Option<(&str, Event)> {
    match event {
        Event::ProcessOutput {
            sequence,
            window_id,
            process_id,
            chunk,
            stream,
            data,
        } => Some((
            data,
            Event::ProcessOutput {
                sequence: *sequence,
                window_id: *window_id,
                process_id: *process_id,
                chunk: *chunk,
                stream: *stream,
                data: String::new(),
            },
        )),
        Event::FileResult {
            id,
            window_id,
            grant_id,
            result: FileResult::Read { data, end_of_file },
        } => Some((
            data,
            Event::FileResult {
                id: *id,
                window_id: *window_id,
                grant_id: *grant_id,
                result: FileResult::Read {
                    data: String::new(),
                    end_of_file: *end_of_file,
                },
            },
        )),
        _ => None,
    }
}

/// Writes one complete event and flushes before returning. Never logs on stdout.
/// Long-lived writers should keep an [`EventWriter`] to reuse its buffer.
pub fn write_event(sink: &mut impl Write, event: &Event) -> Result<(), ProtocolError> {
    EventWriter::default().write(sink, event)
}

#[cfg(test)]
#[path = "framing_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "framing/tests.rs"]
mod edge_tests;
