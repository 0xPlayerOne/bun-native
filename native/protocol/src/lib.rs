//! The bounded, versioned BN0 command channel. This crate has no GUI dependency.
//!
//! A malformed JSON/UTF-8/oversized/truncated frame poisons the channel: callers
//! must terminate it rather than try to resynchronize untrusted bytes. A valid
//! command rejected by the session state instead receives a typed error event.

use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;
use std::io::{self, BufRead, Write};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 65_536;
pub const MAX_TEXT_BYTES: usize = 16_384;
pub const MAX_TITLE_BYTES: usize = 256;
pub const MAX_ID: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Hello {
        id: u64,
        protocol: u32,
    },
    Open {
        id: u64,
        title: String,
        text: String,
        input: String,
    },
    Update {
        id: u64,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "present_string"
        )]
        text: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "present_string"
        )]
        input: Option<String>,
    },
    Close {
        id: u64,
    },
    Shutdown {
        id: u64,
    },
}

fn present_string<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

impl Command {
    pub fn id(&self) -> u64 {
        match self {
            Self::Hello { id, .. }
            | Self::Open { id, .. }
            | Self::Update { id, .. }
            | Self::Close { id }
            | Self::Shutdown { id } => *id,
        }
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.id() == 0 || self.id() > MAX_ID {
            return Err(ProtocolError::InvalidCommand(
                "id must be a positive JavaScript-safe integer",
            ));
        }
        match self {
            Self::Open {
                title, text, input, ..
            } => {
                if title.is_empty()
                    || title.len() > MAX_TITLE_BYTES
                    || title.chars().any(char::is_control)
                {
                    return Err(ProtocolError::InvalidCommand(
                        "title exceeds 256 bytes or contains a control character",
                    ));
                }
                validate_text(text)?;
                validate_text(input)?;
            }
            Self::Update { text, input, .. } => {
                if text.is_none() && input.is_none() {
                    return Err(ProtocolError::InvalidCommand(
                        "update must include text or input",
                    ));
                }
                if let Some(text) = text {
                    validate_text(text)?;
                }
                if let Some(input) = input {
                    validate_text(input)?;
                }
            }
            Self::Hello { .. } | Self::Close { .. } | Self::Shutdown { .. } => {}
        }
        Ok(())
    }
}

fn validate_text(text: &str) -> Result<(), ProtocolError> {
    if text.len() > MAX_TEXT_BYTES || text.contains('\0') {
        Err(ProtocolError::InvalidCommand(
            "text exceeds 16384 bytes or contains NUL",
        ))
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidCommand,
    VersionMismatch,
    InvalidState,
    NativeFailure,
    Backpressure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Ready {
        protocol: u32,
    },
    Ack {
        id: u64,
    },
    Opened {
        id: u64,
    },
    Click,
    Input {
        value: String,
    },
    Closed,
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<u64>,
        code: ErrorCode,
        message: String,
    },
}

#[derive(Debug)]
pub enum ProtocolError {
    Io(io::Error),
    InvalidJson(serde_json::Error),
    InvalidCommand(&'static str),
    Oversized,
    Truncated,
    Poisoned,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "channel I/O failed: {error}"),
            Self::InvalidJson(error) => write!(formatter, "invalid JSON frame: {error}"),
            Self::InvalidCommand(message) => formatter.write_str(message),
            Self::Oversized => formatter.write_str("frame exceeds 65536 bytes"),
            Self::Truncated => formatter.write_str("channel ended within a frame"),
            Self::Poisoned => formatter.write_str("channel is poisoned"),
        }
    }
}

impl std::error::Error for ProtocolError {}

/// Owns at most one bounded frame. Reading cannot grow with an untrusted line.
#[derive(Default)]
pub struct CommandReader {
    poisoned: bool,
    finished: bool,
}

impl CommandReader {
    pub fn read(&mut self, source: &mut impl BufRead) -> Result<Option<Command>, ProtocolError> {
        if self.poisoned {
            return Err(ProtocolError::Poisoned);
        }
        if self.finished {
            return Ok(None);
        }
        let result = self.read_inner(source);
        if result.is_err() {
            self.poisoned = true;
        }
        if matches!(result, Ok(None)) {
            self.finished = true;
        }
        result
    }

    fn read_inner(&mut self, source: &mut impl BufRead) -> Result<Option<Command>, ProtocolError> {
        let mut frame = Vec::new();
        loop {
            let available = source.fill_buf().map_err(ProtocolError::Io)?;
            if available.is_empty() {
                return if frame.is_empty() {
                    Ok(None)
                } else {
                    Err(ProtocolError::Truncated)
                };
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let count = newline.unwrap_or(available.len());
            if frame.len() + count > MAX_FRAME_BYTES {
                return Err(ProtocolError::Oversized);
            }
            frame.extend_from_slice(&available[..count]);
            source.consume(count + usize::from(newline.is_some()));
            if newline.is_some() {
                // serde_json rejects invalid UTF-8, BOMs, empty frames and trailing junk.
                let command: Command =
                    serde_json::from_slice(&frame).map_err(ProtocolError::InvalidJson)?;
                command.validate()?;
                return Ok(Some(command));
            }
        }
    }
}

/// Writes one complete event and flushes before returning. Never logs on stdout.
pub fn write_event(sink: &mut impl Write, event: &Event) -> Result<(), ProtocolError> {
    let mut bytes = serde_json::to_vec(event).map_err(ProtocolError::InvalidJson)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::Oversized);
    }
    bytes.push(b'\n');
    sink.write_all(&bytes).map_err(ProtocolError::Io)?;
    sink.flush().map_err(ProtocolError::Io)
}

#[cfg(test)]
mod tests;
