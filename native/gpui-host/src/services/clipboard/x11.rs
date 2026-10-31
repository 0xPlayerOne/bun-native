//! ICCCM CLIPBOARD selection over the same local X server as the owned GPUI
//! window. The external owner and its properties are untrusted bounded input.

use super::stream::BoundedStream;
use super::{Budget, Failure, WORKER_POLL};
use bun_native_protocol::{ClipboardText, ErrorCode, MAX_CLIPBOARD_BYTES, validate_clipboard_text};
use gpui::App;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xproto::{
    self, Atom, AtomEnum, ConnectionExt, CreateWindowAux, EventMask, PropMode, Property,
    SelectionNotifyEvent, SelectionRequestEvent, Window, WindowClass,
};
use x11rb::reexports::x11rb_protocol::{parse_display::parse_display, xauth};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

type XConnection = RustConnection<BoundedStream>;
const EVENT_BUDGET: usize = 64;
const MAX_AUTH_FILE_BYTES: u64 = 1_048_576;

#[derive(Clone)]
pub(super) struct Config {
    display: u16,
    screen: usize,
}

impl Config {
    pub(super) fn from_app(cx: &App) -> Option<Self> {
        if cx.compositor_name() != "X11" {
            return None;
        }
        let environment = cx.graphical_environment()?;
        let display = environment.x11_display?.into_string().ok()?;
        let parsed = parse_display(Some(&display)).ok()?;
        // No implicit TCP/DNS session change. SSH-forwarded and remote X11
        // clipboard transports remain unavailable in this first slice.
        if (!parsed.host.is_empty() && parsed.host != "unix")
            || parsed
                .protocol
                .as_deref()
                .is_some_and(|protocol| protocol != "unix")
        {
            return None;
        }
        Some(Self {
            display: parsed.display,
            screen: usize::from(parsed.screen),
        })
    }

    fn connect(&self, budget: &Budget) -> Result<Context, Failure> {
        let (stream, (family, address)) =
            BoundedStream::local(&format!("/tmp/.X11-unix/X{}", self.display), budget)?;
        // Authentication remains local session setup, never a clipboard grant.
        // Refuse non-regular/oversized authority files rather than blocking on
        // a pipe or scanning an unbounded file. No credentials enter evidence.
        let authority = std::env::var_os("XAUTHORITY")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".Xauthority"))
            });
        if let Some(path) = authority {
            match std::fs::metadata(path) {
                Ok(metadata) if !metadata.is_file() || metadata.len() > MAX_AUTH_FILE_BYTES => {
                    return Err((
                        ErrorCode::ServiceUnavailable,
                        "X11 authority file is not a bounded regular file",
                    ));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(budget.failure()),
            }
        }
        let (name, data) = xauth::get_auth(family, &address, self.display)
            .unwrap_or(None)
            .unwrap_or_default();
        budget.check()?;
        let connection =
            RustConnection::connect_to_stream_with_auth_info(stream, self.screen, name, data)
                .map_err(|_| budget.failure())?;
        Context::new(connection, self.screen, budget)
    }
}

struct Atoms {
    clipboard: Atom,
    utf8: Atom,
    plain: Atom,
    targets: Atom,
    timestamp: Atom,
    multiple: Atom,
    atom_pair: Atom,
    incr: Atom,
    property: Atom,
}

struct Context {
    connection: XConnection,
    window: Window,
    atoms: Atoms,
    queued: VecDeque<Event>,
}

impl Context {
    fn new(connection: XConnection, screen: usize, budget: &Budget) -> Result<Self, Failure> {
        let atom = |name: &[u8]| -> Result<Atom, Failure> {
            connection
                .intern_atom(false, name)
                .map_err(|_| budget.failure())?
                .reply()
                .map(|reply| reply.atom)
                .map_err(|_| budget.failure())
        };
        let atoms = Atoms {
            clipboard: atom(b"CLIPBOARD")?,
            utf8: atom(b"UTF8_STRING")?,
            plain: atom(b"text/plain;charset=utf-8")?,
            targets: atom(b"TARGETS")?,
            timestamp: atom(b"TIMESTAMP")?,
            multiple: atom(b"MULTIPLE")?,
            atom_pair: atom(b"ATOM_PAIR")?,
            incr: atom(b"INCR")?,
            property: atom(b"_BUN_NATIVE_CLIPBOARD")?,
        };
        let window = connection.generate_id().map_err(|_| budget.failure())?;
        connection
            .create_window(
                0,
                window,
                connection.setup().roots[screen].root,
                0,
                0,
                1,
                1,
                0,
                WindowClass::INPUT_ONLY,
                0,
                &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
            )
            .map_err(|_| budget.failure())?
            .check()
            .map_err(|_| budget.failure())?;
        Ok(Self {
            connection,
            window,
            atoms,
            queued: VecDeque::new(),
        })
    }

    fn timestamp(&mut self, budget: &Budget) -> Result<u32, Failure> {
        self.connection
            .change_property8(
                PropMode::APPEND,
                self.window,
                self.atoms.property,
                AtomEnum::INTEGER,
                &[],
            )
            .map_err(|_| budget.failure())?;
        self.connection.flush().map_err(|_| budget.failure())?;
        loop {
            budget.check()?;
            match self
                .connection
                .poll_for_event()
                .map_err(|_| budget.failure())?
            {
                Some(Event::PropertyNotify(event))
                    if event.window == self.window
                        && event.atom == self.atoms.property
                        && event.state == Property::NEW_VALUE =>
                {
                    return Ok(event.time);
                }
                Some(event) => {
                    if self.queued.len() >= EVENT_BUDGET {
                        return Err((
                            ErrorCode::NativeFailure,
                            "native clipboard event queue exceeded its bound",
                        ));
                    }
                    self.queued.push_back(event);
                }
                None => std::thread::sleep(WORKER_POLL),
            }
        }
    }

    fn next(&mut self, budget: &Budget) -> Result<Option<Event>, Failure> {
        budget.check()?;
        if let Some(event) = self.queued.pop_front() {
            return Ok(Some(event));
        }
        self.connection
            .poll_for_event()
            .map_err(|_| budget.failure())
    }
}

pub(super) struct Owner {
    context: Context,
    text: Option<String>,
    timestamp: u32,
}

pub(super) fn write(
    config: &Config,
    budget: &Budget,
    owner: &mut Option<Owner>,
    text: String,
) -> Result<(), Failure> {
    validate_clipboard_text(&text)
        .map_err(|_| (ErrorCode::PayloadTooLarge, "invalid clipboard text payload"))?;
    if owner.is_none() {
        *owner = Some(Owner {
            context: config.connect(budget)?,
            text: None,
            timestamp: 0,
        });
    }
    let owner = owner.as_mut().expect("owner initialized above");
    owner.context.connection.stream().set_budget(budget);
    let timestamp = owner.context.timestamp(budget)?;
    let context = &owner.context;
    context
        .connection
        .set_selection_owner(context.window, context.atoms.clipboard, timestamp)
        .map_err(|_| budget.failure())?
        .check()
        .map_err(|_| budget.failure())?;
    let actual = context
        .connection
        .get_selection_owner(context.atoms.clipboard)
        .map_err(|_| budget.failure())?
        .reply()
        .map_err(|_| budget.failure())?;
    if actual.owner != context.window {
        return Err((
            ErrorCode::NativeFailure,
            "X11 rejected clipboard selection ownership",
        ));
    }
    owner.text = Some(text);
    owner.timestamp = timestamp;
    Ok(())
}

pub(super) fn serve(owner: &mut Option<Owner>, budget: &Budget) -> Result<(), Failure> {
    let Some(owner) = owner else {
        return Ok(());
    };
    owner.context.connection.stream().set_budget(budget);
    for _ in 0..EVENT_BUDGET {
        match owner.context.next(budget)? {
            Some(Event::SelectionRequest(request)) => {
                // A requestor can disappear between notification and reply.
                // Its BadWindow error must not revoke another owner's request.
                let _ = owner.respond(request, budget);
                budget.check()?;
            }
            Some(Event::SelectionClear(clear))
                if clear.selection == owner.context.atoms.clipboard
                    && clear.owner == owner.context.window =>
            {
                // A queued loss notification may precede a newer successful
                // write, including one with the same millisecond timestamp.
                let actual = owner
                    .context
                    .connection
                    .get_selection_owner(owner.context.atoms.clipboard)
                    .map_err(|_| budget.failure())?
                    .reply()
                    .map_err(|_| budget.failure())?;
                if actual.owner != owner.context.window {
                    owner.text = None;
                }
            }
            Some(_) => {}
            None => break,
        }
    }
    owner
        .context
        .connection
        .flush()
        .map_err(|_| budget.failure())
}

impl Owner {
    fn convert(
        &self,
        requestor: Window,
        target: Atom,
        property: Atom,
        budget: &Budget,
    ) -> Result<(), Failure> {
        let context = &self.context;
        let text = self
            .text
            .as_ref()
            .ok_or((ErrorCode::NativeFailure, "clipboard ownership was lost"))?;
        if target == context.atoms.utf8 || target == context.atoms.plain {
            context
                .connection
                .change_property8(
                    PropMode::REPLACE,
                    requestor,
                    property,
                    target,
                    text.as_bytes(),
                )
                .map_err(|_| budget.failure())?
                .check()
                .map_err(|_| budget.failure())?;
        } else if target == context.atoms.targets {
            context
                .connection
                .change_property32(
                    PropMode::REPLACE,
                    requestor,
                    property,
                    AtomEnum::ATOM,
                    &[
                        context.atoms.targets,
                        context.atoms.timestamp,
                        context.atoms.multiple,
                        context.atoms.utf8,
                        context.atoms.plain,
                    ],
                )
                .map_err(|_| budget.failure())?
                .check()
                .map_err(|_| budget.failure())?;
        } else if target == context.atoms.timestamp {
            context
                .connection
                .change_property32(
                    PropMode::REPLACE,
                    requestor,
                    property,
                    AtomEnum::INTEGER,
                    &[self.timestamp],
                )
                .map_err(|_| budget.failure())?
                .check()
                .map_err(|_| budget.failure())?;
        } else {
            return Err((
                ErrorCode::ServiceUnavailable,
                "unsupported clipboard conversion target",
            ));
        }
        Ok(())
    }

    fn respond(&self, request: SelectionRequestEvent, budget: &Budget) -> Result<(), Failure> {
        let context = &self.context;
        let mut property = if request.property == x11rb::NONE {
            request.target
        } else {
            request.property
        };
        if request.owner != context.window
            || request.selection != context.atoms.clipboard
            || self.text.is_none()
            || (request.time != x11rb::CURRENT_TIME
                && (request.time.wrapping_sub(self.timestamp) as i32) < 0)
        {
            property = x11rb::NONE;
        } else if request.target == context.atoms.multiple {
            // ICCCM MULTIPLE is bounded to 32 target/property pairs; recursive
            // MULTIPLE and aliasing the list property are never executed.
            let reply = context
                .connection
                .get_property(
                    false,
                    request.requestor,
                    property,
                    context.atoms.atom_pair,
                    0,
                    64,
                )
                .map_err(|_| budget.failure())?
                .reply()
                .map_err(|_| budget.failure())?;
            let mut pairs: Vec<u32> = reply.value32().into_iter().flatten().collect();
            if request.property == x11rb::NONE
                || reply.type_ != context.atoms.atom_pair
                || reply.bytes_after != 0
                || !pairs.len().is_multiple_of(2)
            {
                property = x11rb::NONE;
            } else {
                for pair in pairs.as_chunks_mut::<2>().0 {
                    if pair[1] == x11rb::NONE
                        || pair[1] == property
                        || self
                            .convert(request.requestor, pair[0], pair[1], budget)
                            .is_err()
                    {
                        pair[1] = x11rb::NONE;
                    }
                }
                context
                    .connection
                    .change_property32(
                        PropMode::REPLACE,
                        request.requestor,
                        property,
                        context.atoms.atom_pair,
                        &pairs,
                    )
                    .map_err(|_| budget.failure())?
                    .check()
                    .map_err(|_| budget.failure())?;
            }
        } else if self
            .convert(request.requestor, request.target, property, budget)
            .is_err()
        {
            property = x11rb::NONE;
        }
        context
            .connection
            .send_event(
                false,
                request.requestor,
                EventMask::NO_EVENT,
                SelectionNotifyEvent {
                    response_type: xproto::SELECTION_NOTIFY_EVENT,
                    sequence: 0,
                    time: request.time,
                    requestor: request.requestor,
                    selection: request.selection,
                    target: request.target,
                    property,
                },
            )
            .map_err(|_| budget.failure())?
            .check()
            .map_err(|_| budget.failure())?;
        Ok(())
    }
}

pub(super) fn read(
    config: &Config,
    budget: &Budget,
    owner: &mut Option<Owner>,
) -> Result<ClipboardText, Failure> {
    let mut context = config.connect(budget)?;
    let initial_owner = context
        .connection
        .get_selection_owner(context.atoms.clipboard)
        .map_err(|_| budget.failure())?
        .reply()
        .map_err(|_| budget.failure())?
        .owner;
    if initial_owner == x11rb::NONE {
        return Ok(ClipboardText::Empty {});
    }
    let timestamp = context.timestamp(budget)?;
    context
        .connection
        .delete_property(context.window, context.atoms.property)
        .map_err(|_| budget.failure())?;
    context
        .connection
        .convert_selection(
            context.window,
            context.atoms.clipboard,
            context.atoms.utf8,
            context.atoms.property,
            timestamp,
        )
        .map_err(|_| budget.failure())?;
    context.connection.flush().map_err(|_| budget.failure())?;
    let mut incremental = false;
    let mut notified = false;
    let mut bytes = Vec::new();
    let mut owner_probe = Instant::now() + Duration::from_millis(50);
    loop {
        budget.check()?;
        serve(owner, budget)?;
        if Instant::now() >= owner_probe {
            let current = context
                .connection
                .get_selection_owner(context.atoms.clipboard)
                .map_err(|_| budget.failure())?
                .reply()
                .map_err(|_| budget.failure())?
                .owner;
            if current != initial_owner {
                return Err((
                    ErrorCode::NativeFailure,
                    "clipboard owner changed during the transfer",
                ));
            }
            owner_probe = Instant::now() + Duration::from_millis(50);
        }
        let event = context.next(budget)?;
        let property_ready = match event {
            Some(Event::SelectionNotify(event))
                if !notified
                    && event.requestor == context.window
                    && event.selection == context.atoms.clipboard
                    && event.target == context.atoms.utf8
                    && event.time == timestamp =>
            {
                notified = true;
                if event.property == x11rb::NONE {
                    return Err((
                        ErrorCode::ServiceUnavailable,
                        "clipboard owner does not provide UTF-8 text",
                    ));
                }
                if event.property != context.atoms.property {
                    return Err((
                        ErrorCode::NativeFailure,
                        "clipboard owner returned an unexpected property",
                    ));
                }
                true
            }
            Some(Event::PropertyNotify(event))
                if incremental
                    && event.window == context.window
                    && event.atom == context.atoms.property
                    && event.state == Property::NEW_VALUE =>
            {
                true
            }
            Some(_) => false,
            None => {
                std::thread::sleep(WORKER_POLL);
                false
            }
        };
        if !property_ready {
            continue;
        }
        let reply = context
            .connection
            .get_property(
                true,
                context.window,
                context.atoms.property,
                AtomEnum::ANY,
                0,
                MAX_CLIPBOARD_BYTES.div_ceil(4) as u32,
            )
            .map_err(|_| budget.failure())?
            .reply()
            .map_err(|_| budget.failure())?;
        if reply.bytes_after != 0 || bytes.len() + reply.value.len() > MAX_CLIPBOARD_BYTES {
            return Err((
                ErrorCode::PayloadTooLarge,
                "clipboard owner exceeded the UTF-8 byte limit",
            ));
        }
        if reply.type_ == context.atoms.incr && !incremental {
            let values: Vec<_> = reply.value32().into_iter().flatten().collect();
            if values.len() != 1 {
                return Err((
                    ErrorCode::NativeFailure,
                    "invalid incremental clipboard announcement",
                ));
            }
            if values[0] as usize > MAX_CLIPBOARD_BYTES {
                return Err((
                    ErrorCode::PayloadTooLarge,
                    "clipboard owner announced an oversized transfer",
                ));
            }
            incremental = true;
            context.connection.flush().map_err(|_| budget.failure())?;
            continue;
        }
        if reply.type_ != context.atoms.utf8 || reply.format != 8 {
            return Err((
                ErrorCode::NativeFailure,
                "clipboard owner returned invalid UTF-8 property metadata",
            ));
        }
        let finished = !incremental || reply.value.is_empty();
        bytes.extend_from_slice(&reply.value);
        if finished {
            let current_owner = context
                .connection
                .get_selection_owner(context.atoms.clipboard)
                .map_err(|_| budget.failure())?
                .reply()
                .map_err(|_| budget.failure())?
                .owner;
            if current_owner != initial_owner {
                return Err((
                    ErrorCode::NativeFailure,
                    "clipboard owner changed during the transfer",
                ));
            }
            let text = String::from_utf8(bytes).map_err(|_| {
                (
                    ErrorCode::NativeFailure,
                    "clipboard owner returned invalid UTF-8 text",
                )
            })?;
            validate_clipboard_text(&text).map_err(|_| {
                (
                    ErrorCode::NativeFailure,
                    "clipboard owner returned invalid text",
                )
            })?;
            return Ok(ClipboardText::Text { text });
        }
        context.connection.flush().map_err(|_| budget.failure())?;
    }
}
