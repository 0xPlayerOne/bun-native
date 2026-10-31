//! Bun Native's bounded, versioned private host protocol and atomic tree model.
//! Protocol 4 requires native interaction routes; there is no older-version decoder.

mod events;
mod framing;
mod tree;
mod wire;

pub use events::*;
pub use framing::{write_event, CommandReader, ProtocolError};
pub use tree::{BatchMetrics, ModelError, Node, PreparedBatch, Tree};
pub use wire::*;

#[cfg(test)]
mod event_tests;
#[cfg(test)]
mod security_tests;
#[cfg(test)]
mod tests;
