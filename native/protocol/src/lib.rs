//! Bun Native's bounded, versioned private host protocol and atomic tree model.
//! Protocol 11 requires explicit per-operation service policy; no older-version decoder.

mod dialogs;
mod drops;
mod events;
mod files;
mod framing;
mod processes;
mod services;
mod tree;
mod wire;

pub use dialogs::*;
pub use drops::*;
pub use events::*;
pub use files::*;
pub use framing::{write_event, CommandReader, EventWriter, ProtocolError};
pub use processes::*;
pub use services::*;
pub use tree::{BatchMetrics, ModelError, Node, PreparedBatch, Tree, ViewRequest};
pub use wire::*;

#[cfg(test)]
mod dialog_tests;
#[cfg(test)]
mod event_tests;
#[cfg(test)]
mod layout_v2_tests;
#[cfg(test)]
mod overlay_tests;
#[cfg(test)]
mod popup_tests;
#[cfg(test)]
mod request_tests;
#[cfg(test)]
mod security_tests;
#[cfg(test)]
mod service_tests;
#[cfg(test)]
mod tests;
