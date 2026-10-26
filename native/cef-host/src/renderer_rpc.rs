//! Thin CEF adapters around an incarnation-bound renderer bridge.
//! Registry borrows contain no JS execution or CEF calls (including is_same).
use crate::{
    rpc_authority::{Lane, MAX_PACKET_BYTES},
    rpc_protocol::{self as wire, Identity},
};
use cef::*;
use std::{cell::RefCell, collections::BTreeMap};
#[cfg(feature = "rpc-context-diagnostics")]
#[path = "rpc_context_diagnostics.rs"]
mod diagnostics;

#[derive(Clone, Default)]
struct LaneContext {
    receiver: Option<V8Value>,
    send_ack: Option<(u64, V8Value)>,
    sent: u64,
    delivered: u64,
}
#[derive(Clone)]
struct Context {
    serial: u64,
    context: V8Context,
    frame: Frame,
    frame_id: String,
    identity: Option<Identity>,
    stream_retired: bool,
    rpc: LaneContext,
    stream: LaneContext,
}
impl Context {
    fn lane(&self, lane: Lane) -> &LaneContext {
        match lane {
            Lane::Rpc => &self.rpc,
            Lane::Stream => &self.stream,
        }
    }
    fn lane_mut(&mut self, lane: Lane) -> &mut LaneContext {
        match lane {
            Lane::Rpc => &mut self.rpc,
            Lane::Stream => &mut self.stream,
        }
    }
}
#[derive(Default)]
struct Registry {
    next: u64,
    contexts: BTreeMap<i32, Context>,
}
thread_local! { static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default()); }

fn snapshot(browser: i32) -> Option<Context> {
    REGISTRY.with(|registry| registry.borrow().contexts.get(&browser).cloned())
}
fn update<T>(
    browser: i32,
    expected: &Context,
    change: impl FnOnce(&mut Context) -> T,
) -> Option<T> {
    REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let current = registry.contexts.get_mut(&browser)?;
        if current.serial != expected.serial || current.identity != expected.identity {
            return None;
        }
        Some(change(current))
    })
}
fn take(browser: i32, expected: &Context) -> Option<Context> {
    REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let current = registry.contexts.get(&browser)?;
        if current.serial != expected.serial || current.identity != expected.identity {
            return None;
        }
        registry.contexts.remove(&browser)
    })
}
fn unbound(serial: u64) -> Identity {
    Identity {
        context: serial,
        connection: 0,
        generation: 0,
    }
}
fn send(
    frame: &Frame,
    name: &str,
    identity: Identity,
    sequence: u64,
    bytes: Option<&[u8]>,
) -> bool {
    let Some(mut message) = wire::message(name, identity, sequence, bytes) else {
        return false;
    };
    frame.send_process_message(ProcessId::BROWSER, Some(&mut message));
    true
}
fn invoke(context: &V8Context, callback: &V8Value, argument: Option<V8Value>) -> Option<V8Value> {
    if context.is_valid() == 0 {
        return None;
    }
    let mut context = context.clone();
    let args = argument.map(|value| vec![Some(value)]).unwrap_or_default();
    callback.execute_function_with_context(Some(&mut context), None, Some(&args))
}
fn settle(context: Context, notify_browser: bool) {
    if notify_browser {
        send(
            &context.frame,
            wire::RELEASE,
            context.identity.unwrap_or(unbound(context.serial)),
            0,
            None,
        );
    }
    // Remove registry state before either callback, since each can re-enter.
    for lane in [context.rpc, context.stream] {
        if let Some((_, callback)) = lane.send_ack {
            invoke_bool(&context.context, &callback, false);
        }
        if let Some(callback) = lane.receiver {
            invoke(&context.context, &callback, None);
        }
    }
}
fn invoke_bool(context: &V8Context, callback: &V8Value, value: bool) {
    if context.is_valid() == 0 || context.enter() == 0 {
        return;
    }
    let value = v8_value_create_bool(i32::from(value));
    context.exit();
    if let Some(value) = value {
        invoke(context, callback, Some(value));
    }
}
fn revoke(browser: i32, expected: &Context, notify_browser: bool) {
    if let Some(context) = take(browser, expected) {
        settle(context, notify_browser);
    }
}
fn close_stream(browser: i32, expected: &Context, notify_browser: bool) {
    let retired = update(browser, expected, |context| {
        context.stream_retired = true;
        std::mem::take(&mut context.stream)
    });
    let Some(retired) = retired else {
        return;
    };
    if notify_browser {
        if let Some(identity) = expected.identity {
            send(&expected.frame, wire::STREAM_RELEASE, identity, 0, None);
        }
    }
    if let Some((_, callback)) = retired.send_ack {
        invoke_bool(&expected.context, &callback, false);
    }
    if let Some(callback) = retired.receiver {
        invoke(&expected.context, &callback, None);
    }
}
fn same_context(context: &Context) -> bool {
    let (Some(mut current), Some(mut entered)) = (
        v8_context_get_current_context(),
        v8_context_get_entered_context(),
    ) else {
        return false;
    };
    context.context.is_valid() != 0
        && context.context.is_same(Some(&mut current)) != 0
        && context.context.is_same(Some(&mut entered)) != 0
        && context.frame.is_valid() != 0
        && context.frame.is_main() != 0
}
fn execute(
    browser: i32,
    identity: Identity,
    lane: Lane,
    operation: &str,
    arguments: &[Option<V8Value>],
) -> Result<(), &'static str> {
    let current = snapshot(browser).ok_or("RPC document authority was revoked")?;
    if current.identity != Some(identity) || !same_context(&current) {
        return Err("RPC function belongs to another document context");
    }
    if lane == Lane::Stream && current.stream_retired {
        return Err("Native stream lane was retired");
    }
    if operation == "close" {
        if !arguments.is_empty() {
            return Err("RPC close takes no arguments");
        }
        if lane == Lane::Stream {
            close_stream(browser, &current, true);
        } else {
            revoke(browser, &current, true);
        }
        return Ok(());
    }
    if operation == "subscribe" {
        if arguments.len() != 1
            || arguments[0]
                .as_ref()
                .is_none_or(|value| value.is_function() == 0)
        {
            return Err("RPC subscribe requires one callback");
        }
        let callback = arguments[0].clone();
        let registered = update(browser, &current, |context| {
            let state = context.lane_mut(lane);
            if state.receiver.is_some() {
                return false;
            }
            state.receiver = callback;
            true
        })
        .unwrap_or(false);
        if !registered {
            return Err("RPC listener already registered or context replaced");
        }
        let subscribed = if lane == Lane::Rpc {
            wire::SUBSCRIBED
        } else {
            wire::STREAM_SUBSCRIBED
        };
        if !send(&current.frame, subscribed, identity, 0, None) {
            revoke(browser, &current, true);
            return Err("RPC subscribe allocation failed");
        }
        #[cfg(feature = "rpc-qualification")]
        if lane == Lane::Rpc {
            // This PID comes from this compiled helper, not the page. The browser
            // binds the proof to the same native main frame and document identity.
            if !send(
                &current.frame,
                wire::RENDERER_PROOF,
                identity,
                u64::from(std::process::id()),
                None,
            ) {
                revoke(browser, &current, true);
                return Err("Renderer proof allocation failed");
            }
            crate::rpc_qualification::subscribed(&current.frame, identity);
        }
        return Ok(());
    }
    if current.lane(lane).receiver.is_none()
        || arguments.len() != 2
        || arguments[0]
            .as_ref()
            .is_none_or(|value| value.is_array_buffer() == 0)
        || arguments[1]
            .as_ref()
            .is_none_or(|value| value.is_function() == 0)
    {
        return Err("RPC send requires a listener, ArrayBuffer and callback");
    }
    let buffer = arguments[0].as_ref().unwrap();
    let bytes = buffer.array_buffer_byte_length();
    let pointer = buffer.array_buffer_data();
    if bytes == 0 || bytes > MAX_PACKET_BYTES || pointer.is_null() {
        return Err("RPC packet size denied");
    }
    let owned = unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), bytes) }.to_vec();
    let sequence = wire::next(current.lane(lane).sent).ok_or("Native lane sequence exhausted")?;
    let packet_name = if lane == Lane::Rpc {
        wire::PACKET
    } else {
        wire::STREAM_PACKET
    };
    let mut message = wire::message(packet_name, identity, sequence, Some(&owned))
        .ok_or("RPC allocation failed")?;
    let reserved = update(browser, &current, |context| {
        let state = context.lane_mut(lane);
        if state.send_ack.is_some() || state.sent != current.lane(lane).sent {
            return false;
        }
        state.sent = sequence;
        state.send_ack = Some((sequence, arguments[1].clone().unwrap()));
        true
    })
    .unwrap_or(false);
    if !reserved {
        return Err("RPC packet already pending or context replaced");
    }
    current
        .frame
        .send_process_message(ProcessId::BROWSER, Some(&mut message));
    Ok(())
}

fn write_exception(error: Option<&mut CefString>, reason: &str) -> bool {
    // The pinned trampoline lends us CEF's mutable output slot. Replacing this
    // Rust wrapper only replaces a local value and silently leaves CEF empty.
    error.is_some_and(|error| error.try_set(reason))
}
fn execute_callback(
    browser: i32,
    identity: Identity,
    lane: Lane,
    operation: &str,
    arguments: &[Option<V8Value>],
    error: Option<&mut CefString>,
) {
    #[cfg(feature = "rpc-context-diagnostics")]
    let diagnostic = diagnostics::begin(browser, identity, operation);
    let result = execute(browser, identity, lane, operation, arguments);
    let exception_written = match result {
        Err(reason) => write_exception(error, reason),
        Ok(()) => false,
    };
    #[cfg(feature = "rpc-context-diagnostics")]
    diagnostics::finish(diagnostic, result, exception_written);
    #[cfg(not(feature = "rpc-context-diagnostics"))]
    let _ = exception_written;
}

wrap_v8_handler! {
    struct RpcV8Handler { browser: i32, identity: Identity, lane: Lane, operation: String }
    impl V8Handler {
        fn execute(&self, _name: Option<&CefString>, _object: Option<&mut V8Value>, arguments: Option<&[Option<V8Value>]>, _retval: Option<&mut Option<V8Value>>, error: Option<&mut CefString>) -> i32 {
            execute_callback(self.browser, self.identity, self.lane, &self.operation, arguments.unwrap_or_default(), error);
            1
        }
    }
}

fn install(browser: i32, expected: &Context, identity: Identity) -> bool {
    if expected.identity.is_some()
        || identity.context != expected.serial
        || identity.connection == 0
        || identity.generation == 0
        || expected.context.is_valid() == 0
        || expected.context.enter() == 0
    {
        return false;
    }
    let result = install_entered(browser, expected, identity);
    expected.context.exit();
    result
}
fn install_entered(browser: i32, expected: &Context, identity: Identity) -> bool {
    let Some(global) = expected.context.global() else {
        return false;
    };
    let attributes = sys::cef_v8_propertyattribute_t(
        sys::cef_v8_propertyattribute_t::V8_PROPERTY_ATTRIBUTE_READONLY.0
            | sys::cef_v8_propertyattribute_t::V8_PROPERTY_ATTRIBUTE_DONTDELETE.0
            | sys::cef_v8_propertyattribute_t::V8_PROPERTY_ATTRIBUTE_DONTENUM.0,
    )
    .into();
    for (lane, global_name) in [(Lane::Rpc, "__bunlyRpc"), (Lane::Stream, "__bunlyStreams")] {
        let Some(bridge) = v8_value_create_object(None, None) else {
            return false;
        };
        for operation in ["send", "subscribe", "close"] {
            let key = CefString::from(operation);
            let mut handler = RpcV8Handler::new(browser, identity, lane, operation.to_owned());
            let mut function = v8_value_create_function(Some(&key), Some(&mut handler));
            if bridge.set_value_bykey(Some(&key), function.as_mut(), attributes) == 0 {
                return false;
            }
        }
        let mut bridge = Some(bridge);
        if global.set_value_bykey(
            Some(&CefString::from(global_name)),
            bridge.as_mut(),
            attributes,
        ) == 0
        {
            return false;
        }
    }
    if update(browser, expected, |context| {
        context.identity = Some(identity);
    })
    .is_none()
    {
        return false;
    }
    // Fixed no-payload event is merely a wakeup. It conveys no authority.
    // Page listeners may re-enter; no registry borrow survives this call.
    let mut result = None;
    let mut error = None;
    expected.context.eval(
        Some(&CefString::from(
            "Object.freeze(globalThis.__bunlyRpc);Object.freeze(globalThis.__bunlyStreams);globalThis.dispatchEvent(new Event('bunly:rpc-ready'));globalThis.dispatchEvent(new Event('bunly:streams-ready'))",
        )),
        None,
        0,
        Some(&mut result),
        Some(&mut error),
    ) != 0
}
fn context_created(browser: &Browser, frame: &Frame, context: &V8Context) {
    if frame.is_main() == 0 {
        #[cfg(feature = "rpc-qualification")]
        if let Some(identity) = snapshot(browser.identifier()).and_then(|context| context.identity)
        {
            crate::rpc_qualification::child(frame, identity);
        }
        return;
    }
    let browser = browser.identifier();
    let frame_id = CefString::from(&frame.identifier()).to_string();
    let serial = REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        if registry.contexts.len() >= 128 && !registry.contexts.contains_key(&browser) {
            return None;
        }
        registry.next = wire::next(registry.next)?;
        Some(registry.next)
    });
    let Some(serial) = serial else {
        return;
    };
    let new_context = Context {
        serial,
        context: context.clone(),
        frame: frame.clone(),
        frame_id,
        identity: None,
        stream_retired: false,
        rpc: LaneContext::default(),
        stream: LaneContext::default(),
    };
    let old = REGISTRY.with(|registry| registry.borrow_mut().contexts.insert(browser, new_context));
    if let Some(old) = old {
        settle(old, true);
    }
    if snapshot(browser).is_some_and(|current| current.serial == serial) {
        send(frame, wire::READY, unbound(serial), 0, None);
    }
}
fn context_released(browser: &Browser, context: &V8Context) {
    let id = browser.identifier();
    let Some(expected) = snapshot(id) else {
        return;
    };
    let mut released = context.clone();
    if expected.context.is_same(Some(&mut released)) != 0 {
        revoke(id, &expected, true);
    }
}
fn browser_destroyed(browser: &Browser) {
    let id = browser.identifier();
    if let Some(expected) = snapshot(id) {
        revoke(id, &expected, false);
    }
}
fn acknowledge(browser: i32, expected: &Context, lane: Lane, sequence: u64) {
    let callback = update(browser, expected, |context| {
        let state = context.lane_mut(lane);
        if state.send_ack.as_ref().map(|(seq, _)| *seq) != Some(sequence) {
            return None;
        }
        state.send_ack.take().map(|(_, callback)| callback)
    })
    .flatten();
    if let Some(callback) = callback {
        invoke_bool(&expected.context, &callback, true);
    }
}
fn receipt(
    browser: i32,
    frame: &Frame,
    identity: Identity,
    lane: Lane,
    sequence: u64,
    consumed: bool,
) {
    // Run after the message callback unwinds and CEF releases its input buffer.
    // The task owns metadata only; byte reservations remain at the sender.
    let mut task = DeliveryReceipt::new(browser, frame.clone(), identity, lane, sequence, consumed);
    post_task(ThreadId::RENDERER, Some(&mut task));
}
wrap_task! {
    struct DeliveryReceipt { browser: i32, frame: Frame, identity: Identity, lane: Lane, sequence: u64, consumed: bool }
    impl Task {
        fn execute(&self) {
            let live = snapshot(self.browser).is_some_and(|current| current.identity == Some(self.identity) && (self.lane == Lane::Rpc || !current.stream_retired));
            let name = match (self.lane, self.consumed && live) {
                (Lane::Rpc, true) => wire::DELIVERED,
                (Lane::Rpc, false) => wire::DISCARDED,
                (Lane::Stream, true) => wire::STREAM_DELIVERED,
                (Lane::Stream, false) => wire::STREAM_DISCARDED,
            };
            send(&self.frame, name, self.identity, self.sequence, None);
        }
    }
}
fn deliver(
    browser: i32,
    expected: &Context,
    identity: Identity,
    lane: Lane,
    sequence: u64,
    message: &ProcessMessage,
) {
    // A packet already owned by CEF can arrive after lane-local retirement.
    // Discard and release that exact packet without revoking sibling RPC.
    if lane == Lane::Stream && expected.stream_retired {
        receipt(browser, &expected.frame, identity, lane, sequence, false);
        return;
    }
    let Some(mut bytes) = wire::binary(message) else {
        if lane == Lane::Stream {
            close_stream(browser, expected, true);
        } else {
            revoke(browser, expected, true);
        }
        return;
    };
    let Some(callback) = expected.lane(lane).receiver.clone() else {
        drop(bytes);
        receipt(browser, &expected.frame, identity, lane, sequence, false);
        if lane == Lane::Stream {
            close_stream(browser, expected, true);
        } else {
            revoke(browser, expected, true);
        }
        return;
    };
    if wire::next(expected.lane(lane).delivered) != Some(sequence) {
        return;
    }
    if update(browser, expected, |context| {
        let state = context.lane_mut(lane);
        if state.delivered != expected.lane(lane).delivered {
            return false;
        }
        state.delivered = sequence;
        true
    }) != Some(true)
    {
        return;
    }
    // ArrayBuffer allocation must run inside its owning context.
    if expected.context.is_valid() == 0 || expected.context.enter() == 0 {
        return;
    }
    let value = v8_value_create_array_buffer_with_copy(bytes.as_mut_ptr(), bytes.len());
    expected.context.exit();
    drop(bytes);
    let consumed = value
        .and_then(|value| invoke(&expected.context, &callback, Some(value)))
        .is_some_and(|value| value.is_bool() != 0 && value.bool_value() != 0);
    let still_current = snapshot(browser).is_some_and(|current| {
        current.serial == expected.serial
            && current.identity == Some(identity)
            && (lane == Lane::Rpc || !current.stream_retired)
    });
    // No positive acknowledgement for a missing/throwing listener or reentrant
    // replacement. DISCARDED only releases the original transport reservation.
    receipt(
        browser,
        &expected.frame,
        identity,
        lane,
        sequence,
        consumed && still_current,
    );
    if !consumed {
        if lane == Lane::Stream {
            close_stream(browser, expected, true);
        } else {
            revoke(browser, expected, true);
        }
    }
}
fn process_message(
    browser: &Browser,
    frame: &Frame,
    source: ProcessId,
    message: &ProcessMessage,
) -> i32 {
    if source != ProcessId::BROWSER {
        return 0;
    }
    let name = CefString::from(&message.name()).to_string();
    if ![
        wire::GRANT,
        wire::REVOKE,
        wire::ACK,
        wire::DELIVER,
        wire::STREAM_REVOKE,
        wire::STREAM_ACK,
        wire::STREAM_DELIVER,
    ]
    .contains(&name.as_str())
    {
        return 0;
    }
    let payload = [wire::DELIVER, wire::STREAM_DELIVER].contains(&name.as_str());
    let Some((identity, sequence)) = wire::read(message, payload) else {
        return 1;
    };
    let id = browser.identifier();
    let frame_id = CefString::from(&frame.identifier()).to_string();
    if frame.is_main() == 0 {
        return 1;
    }
    let Some(expected) = snapshot(id)
        .filter(|context| context.serial == identity.context && context.frame_id == frame_id)
    else {
        #[cfg(feature = "rpc-qualification")]
        if let Some(current) = snapshot(id).filter(|current| current.frame_id == frame_id) {
            if let Some(live) = current.identity {
                let case = match name.as_str() {
                    wire::GRANT => 1,
                    wire::ACK => 2,
                    wire::REVOKE => 3,
                    wire::DELIVER => 4,
                    _ => 0,
                };
                send(frame, "bunly.rpc.qualification", live, case, None);
            }
        }
        if payload {
            let lane = if name == wire::STREAM_DELIVER {
                Lane::Stream
            } else {
                Lane::Rpc
            };
            receipt(id, frame, identity, lane, sequence, false);
        }
        return 1;
    };
    if name == wire::GRANT {
        if sequence == 0 && expected.identity.is_none() && !install(id, &expected, identity) {
            if let Some(current) = snapshot(id).filter(|current| current.serial == expected.serial)
            {
                revoke(id, &current, true);
            }
        }
        return 1;
    }
    if expected.identity != Some(identity) {
        return 1;
    }
    match name.as_str() {
        wire::REVOKE if sequence == 0 => revoke(id, &expected, false),
        wire::STREAM_REVOKE if sequence == 0 => close_stream(id, &expected, false),
        wire::ACK if sequence > 0 => acknowledge(id, &expected, Lane::Rpc, sequence),
        wire::STREAM_ACK if sequence > 0 => acknowledge(id, &expected, Lane::Stream, sequence),
        wire::DELIVER if sequence > 0 => {
            deliver(id, &expected, identity, Lane::Rpc, sequence, message)
        }
        wire::STREAM_DELIVER if sequence > 0 => {
            deliver(id, &expected, identity, Lane::Stream, sequence, message)
        }
        _ => (),
    }
    1
}

wrap_render_process_handler! {
    struct BunlyRenderer;
    impl RenderProcessHandler {
        fn on_context_created(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, context: Option<&mut V8Context>) {
            if let (Some(browser), Some(frame), Some(context)) = (browser, frame, context) { context_created(browser, frame, context); }
        }
        fn on_context_released(&self, browser: Option<&mut Browser>, _frame: Option<&mut Frame>, context: Option<&mut V8Context>) {
            if let (Some(browser), Some(context)) = (browser, context) { context_released(browser, context); }
        }
        fn on_browser_destroyed(&self, browser: Option<&mut Browser>) {
            if let Some(browser) = browser { browser_destroyed(browser); }
        }
        fn on_process_message_received(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, source: ProcessId, message: Option<&mut ProcessMessage>) -> i32 {
            match (browser, frame, message) { (Some(browser), Some(frame), Some(message)) => process_message(browser, frame, source, message), _ => 0 }
        }
    }
}
pub fn handler() -> RenderProcessHandler {
    BunlyRenderer::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejection_writes_through_the_cef_owned_exception_slot() {
        // Loading Chromium interposes process-global allocation on macOS. Do
        // not introduce it into the parallel pure-Rust/keychain test process.
        // Run this real string ABI check in an owned, bounded child instead.
        if std::env::var("BUNLY_TEST_CEF_STRING_ABI").as_deref() != Ok("1") {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "renderer_rpc::tests::rejection_writes_through_the_cef_owned_exception_slot",
                    "--nocapture",
                ])
                .env("BUNLY_TEST_CEF_STRING_ABI", "1")
                .stdin(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success(), "CEF string ABI child failed: {status}");
                    return;
                }
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("CEF string ABI child deadline exceeded");
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        // macOS uses a forwarding table, also for the pure string functions.
        // Load the real library as upstream's string tests do; never initialize
        // CEF, V8, a browser, a message loop, or a GUI in this unit test.
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::ffi::OsStrExt;
            let framework = sys::get_cef_dir()
                .expect("Real CEF distribution required")
                .join(sys::FRAMEWORK_PATH)
                .canonicalize()
                .unwrap();
            let path = std::ffi::CString::new(framework.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { sys::cef_load_library(path.as_ptr()) }, 1);
        }
        // Reproduce the exact borrowed mutable string passed by the pinned
        // cef-rs V8Handler C trampoline, without initializing a browser or V8.
        let mut raw: sys::cef_string_t = unsafe { std::mem::zeroed() };
        {
            let mut borrowed = CefString::from(std::ptr::addr_of_mut!(raw));
            assert!(write_exception(
                Some(&mut borrowed),
                "RPC function belongs to another document context"
            ));
        }
        let observed = CefString::from(std::ptr::addr_of!(raw)).to_string();
        unsafe {
            sys::cef_string_utf16_clear(&mut raw);
        }
        assert_eq!(observed, "RPC function belongs to another document context");
    }
}
