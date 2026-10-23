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

// A synthetic device makes the actual media-permission callback test independent
// of runner hardware. Unlike fake UI/auto-accept switches, this does not grant
// permission; the fixture still requires Bunly's real denial callback.
static MEDIA_DEVICES: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn allow_media_fixture(process_type: &str, requested: bool, origin: Option<&str>) -> bool {
    requested
        && process_type.is_empty()
        && origin.is_some_and(|origin| crate::policy::development_origin(origin).is_ok())
}
pub fn configure_media_devices(
    process_type: Option<&CefString>,
    command: Option<&mut CommandLine>,
) {
    let process_type = process_type
        .map(|value| value.to_string())
        .unwrap_or_default();
    let requested = std::env::var("BUNLY_POLICY_QUALIFICATION").as_deref() == Ok("1");
    let origin = crate::PATHS
        .get()
        .and_then(|paths| paths.dev_origin.as_deref());
    if !allow_media_fixture(&process_type, requested, origin) {
        return;
    }
    if let Some(command) = command {
        command.append_switch(Some(&CefString::from("use-fake-device-for-media-stream")));
        MEDIA_DEVICES.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}
pub fn media_devices_enabled() -> bool {
    MEDIA_DEVICES.load(std::sync::atomic::Ordering::SeqCst)
}

#[cfg(test)]
mod media_tests {
    use super::*;
    #[test]
    fn synthetic_devices_require_explicit_contributor_development_fixture() {
        let origin = Some("http://127.0.0.1:8080");
        assert!(allow_media_fixture("", true, origin));
        assert!(!allow_media_fixture("", false, origin));
        for process in ["renderer", "utility", "gpu-process"] {
            assert!(!allow_media_fixture(process, true, origin));
        }
        for invalid in [
            None,
            Some("app://ui"),
            Some("https://remote.invalid"),
            Some("http://localhost:8080"),
            Some("http://127.0.0.1:8080/"),
        ] {
            assert!(!allow_media_fixture("", true, invalid));
        }
    }
}
