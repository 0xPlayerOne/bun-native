//! Private CEF messages. None of these fields are accepted from JavaScript.
use cef::*;

pub const MAX_ID: u64 = 9_007_199_254_740_991;
pub const READY: &str = "bunly.rpc.context-ready";
#[cfg(feature = "rpc-qualification")]
pub const RENDERER_PROOF: &str = "bunly.rpc.renderer-proof";
pub const GRANT: &str = "bunly.rpc.grant";
pub const SUBSCRIBED: &str = "bunly.rpc.subscribed";
pub const RELEASE: &str = "bunly.rpc.release";
pub const REVOKE: &str = "bunly.rpc.revoke";
pub const PACKET: &str = "bunly.rpc.packet";
pub const ACK: &str = "bunly.rpc.ack";
pub const DELIVER: &str = "bunly.rpc.deliver";
pub const DELIVERED: &str = "bunly.rpc.delivered";
pub const DISCARDED: &str = "bunly.rpc.discarded";
pub const STREAM_SUBSCRIBED: &str = "bunly.stream.subscribed";
pub const STREAM_RELEASE: &str = "bunly.stream.release";
pub const STREAM_REVOKE: &str = "bunly.stream.revoke";
pub const STREAM_PACKET: &str = "bunly.stream.packet";
pub const STREAM_ACK: &str = "bunly.stream.ack";
pub const STREAM_DELIVER: &str = "bunly.stream.deliver";
pub const STREAM_DELIVERED: &str = "bunly.stream.delivered";
pub const STREAM_DISCARDED: &str = "bunly.stream.discarded";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Identity {
    pub context: u64,
    pub connection: u64,
    pub generation: u64,
}

pub fn next(value: u64) -> Option<u64> {
    value.checked_add(1).filter(|value| *value <= MAX_ID)
}

pub fn integer(value: f64, allow_zero: bool) -> Option<u64> {
    if !(value.is_finite()
        && value.fract() == 0.0
        && !value.is_sign_negative()
        && value >= if allow_zero { 0.0 } else { 1.0 }
        && value <= MAX_ID as f64)
    {
        return None;
    }
    Some(value as u64)
}

pub fn read(message: &ProcessMessage, payload: bool) -> Option<(Identity, u64)> {
    let args = message.argument_list()?;
    if args.size() != if payload { 5 } else { 4 } {
        return None;
    }
    for index in 0..4 {
        if args.get_type(index) != ValueType::DOUBLE {
            return None;
        }
    }
    Some((
        Identity {
            context: integer(args.double(0), false)?,
            connection: integer(args.double(1), true)?,
            generation: integer(args.double(2), true)?,
        },
        integer(args.double(3), true)?,
    ))
}

pub fn message(
    name: &str,
    identity: Identity,
    sequence: u64,
    bytes: Option<&[u8]>,
) -> Option<ProcessMessage> {
    if identity.context == 0
        || [
            identity.context,
            identity.connection,
            identity.generation,
            sequence,
        ]
        .iter()
        .any(|value| *value > MAX_ID)
    {
        return None;
    }
    let message = process_message_create(Some(&CefString::from(name)))?;
    let args = message.argument_list()?;
    for (index, value) in [
        identity.context,
        identity.connection,
        identity.generation,
        sequence,
    ]
    .iter()
    .enumerate()
    {
        if args.set_double(index, *value as f64) == 0 {
            return None;
        }
    }
    if let Some(bytes) = bytes {
        if bytes.is_empty() || bytes.len() > crate::rpc_authority::MAX_PACKET_BYTES {
            return None;
        }
        let mut binary = binary_value_create(Some(bytes))?;
        if args.set_binary(4, Some(&mut binary)) == 0 {
            return None;
        }
    }
    Some(message)
}

pub fn binary(message: &ProcessMessage) -> Option<Vec<u8>> {
    let args = message.argument_list()?;
    if args.get_type(4) != ValueType::BINARY {
        return None;
    }
    let binary = args.binary(4)?;
    let size = binary.size();
    if size == 0 || size > crate::rpc_authority::MAX_PACKET_BYTES {
        return None;
    }
    let mut bytes = vec![0; size];
    (binary.data(Some(&mut bytes), 0) == size).then_some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numeric_metadata_never_truncates_or_reuses_identity() {
        for value in [
            f64::NAN,
            f64::INFINITY,
            -1.0,
            -0.0,
            0.5,
            MAX_ID as f64 + 1.0,
        ] {
            assert_eq!(integer(value, true), None);
        }
        assert_eq!(integer(0.0, false), None);
        assert_eq!(integer(MAX_ID as f64, false), Some(MAX_ID));
        assert_eq!(next(MAX_ID), None);
    }
}
