//! Bun Native's bounded, versioned private host protocol and atomic tree model.
//! Protocol 7 requires explicit per-operation service policy; no older-version decoder.

mod events;
mod framing;
mod services;
mod tree;
mod wire;

pub use events::*;
pub use framing::{write_event, CommandReader, EventWriter, ProtocolError};
pub use services::*;
pub use tree::{BatchMetrics, ModelError, Node, PreparedBatch, Tree};
pub use wire::*;

#[cfg(test)]
mod event_tests;
#[cfg(test)]
mod security_tests;
#[cfg(test)]
mod service_tests;
#[cfg(test)]
mod tests;
