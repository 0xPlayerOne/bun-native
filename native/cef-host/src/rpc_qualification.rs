//! Compile-time contributor probes sent through actual CEF process messaging.
//! Not included in ordinary runtime builds; never exposed through a JS method.
use crate::{rpc_protocol as wire, rpc_protocol::Identity};
use cef::*;

fn packet() -> Vec<u8> {
    let metadata = br#"{"v":1,"type":"request","id":1,"method":"echo","timeoutMs":1000,"payload":{"kind":"json","value":"forged-native-probe"}}"#;
    let mut bytes = b"BLRP".to_vec();
    bytes.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&0u32.to_be_bytes());
    bytes.extend_from_slice(metadata);
    bytes
}
fn send(frame: &Frame, identity: Identity) {
    if let Some(mut message) = wire::message(wire::PACKET, identity, 1, Some(&packet())) {
        frame.send_process_message(ProcessId::BROWSER, Some(&mut message));
    }
}
pub fn subscribed(frame: &Frame, identity: Identity) {
    // These precede the first legitimate page packet, so sequence 1 would be
    // admissible if incarnation validation were missing.
    send(
        frame,
        Identity {
            context: wire::MAX_ID,
            ..identity
        },
    );
    send(
        frame,
        Identity {
            connection: wire::MAX_ID,
            ..identity
        },
    );
    send(
        frame,
        Identity {
            generation: wire::MAX_ID,
            ..identity
        },
    );
    if let Some(mut message) = wire::message(wire::PACKET, identity, 1, Some(&packet())) {
        if let Some(args) = message.argument_list() {
            args.set_double(3, 0.5);
        }
        frame.send_process_message(ProcessId::BROWSER, Some(&mut message));
    }
    if let Some(mut message) = wire::message(wire::SUBSCRIBED, identity, 0, None) {
        frame.send_process_message(ProcessId::BROWSER, Some(&mut message));
    }
    if let Some(mut message) = wire::message(
        wire::READY,
        Identity {
            context: identity.context,
            connection: 0,
            generation: 0,
        },
        0,
        None,
    ) {
        frame.send_process_message(ProcessId::BROWSER, Some(&mut message));
    }
}
pub fn child(frame: &Frame, parent: Identity) {
    send(frame, parent);
}
pub fn stale_browser_messages(frame: &Frame, identity: Identity) {
    let stale = Identity {
        context: wire::MAX_ID,
        ..identity
    };
    replay_browser_messages(frame, stale);
}
pub fn replay_browser_messages(frame: &Frame, stale: Identity) {
    for name in [wire::GRANT, wire::ACK, wire::REVOKE] {
        if let Some(mut message) =
            wire::message(name, stale, if name == wire::ACK { 1 } else { 0 }, None)
        {
            frame.send_process_message(ProcessId::RENDERER, Some(&mut message));
        }
    }
    if let Some(mut message) = wire::message(wire::DELIVER, stale, 1, Some(&packet())) {
        frame.send_process_message(ProcessId::RENDERER, Some(&mut message));
    }
}
