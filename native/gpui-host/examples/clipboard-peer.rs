//! Independent, foreground ICCCM fixture. Never run against a personal display.
//! The native diagnostics controller owns this process and its isolated Xvfb.

#[cfg(target_os = "linux")]
mod linux {
    use serde_json::{Value, json};
    use std::error::Error;
    use std::io::{self, Write};
    use std::path::PathBuf;
    use std::time::{Duration, Instant};
    use x11rb::connection::Connection;
    use x11rb::protocol::Event;
    use x11rb::protocol::xproto::{
        self, Atom, AtomEnum, ConnectionExt, CreateWindowAux, EventMask, PropMode, Property,
        SelectionNotifyEvent, SelectionRequestEvent, WindowClass,
    };
    use x11rb::rust_connection::RustConnection;
    use x11rb::wrapper::ConnectionExt as _;

    type Result<T> = std::result::Result<T, Box<dyn Error>>;
    const POLL: Duration = Duration::from_millis(5);
    const MAX_TEXT: usize = 8192;

    struct Peer {
        connection: RustConnection,
        window: u32,
        clipboard: Atom,
        utf8: Atom,
        targets: Atom,
        timestamp: Atom,
        multiple: Atom,
        atom_pair: Atom,
        incr: Atom,
        property: Atom,
        nonce: String,
        label: String,
        stop: PathBuf,
        deadline: Instant,
        log_bytes: usize,
    }

    impl Peer {
        fn new(label: String) -> Result<Self> {
            if std::env::var("BUN_NATIVE_ISOLATED_CLIPBOARD").as_deref() != Ok("1") {
                return Err("clipboard peer requires the explicit isolated-test guard".into());
            }
            if label.is_empty()
                || label.len() > 40
                || !label
                    .bytes()
                    .all(|value| value.is_ascii_alphanumeric() || value == b'-')
            {
                return Err("invalid clipboard peer label".into());
            }
            let directory = PathBuf::from(std::env::var("BUN_NATIVE_DIAGNOSTICS_DIR")?);
            if !directory.is_absolute() || !directory.is_dir() {
                return Err(
                    "clipboard peer requires the existing absolute diagnostic directory".into(),
                );
            }
            let nonce = std::env::var("BUN_NATIVE_EVIDENCE_NONCE")?;
            if nonce.len() != 32 || !nonce.bytes().all(|value| value.is_ascii_hexdigit()) {
                return Err("invalid clipboard peer nonce".into());
            }
            // The parent records this owned child's PID/start identity before
            // allowing even a fast no-owner read to exit and be reaped.
            let start = directory.join(format!("clipboard-{label}.start"));
            let ready_deadline = Instant::now() + Duration::from_secs(3);
            while !start.exists() {
                if Instant::now() >= ready_deadline {
                    return Err("clipboard peer identity handshake expired".into());
                }
                std::thread::sleep(POLL);
            }
            let display = std::env::var("DISPLAY")?;
            if !display.starts_with(':')
                || !display[1..]
                    .bytes()
                    .all(|value| value.is_ascii_digit() || value == b'.')
            {
                return Err(
                    "clipboard peer accepts only the explicitly isolated local X display".into(),
                );
            }
            let (connection, screen) = x11rb::connect(Some(&display))?;
            let atom = |name: &[u8]| -> Result<Atom> {
                Ok(connection.intern_atom(false, name)?.reply()?.atom)
            };
            let clipboard = atom(b"CLIPBOARD")?;
            let utf8 = atom(b"UTF8_STRING")?;
            let targets = atom(b"TARGETS")?;
            let timestamp = atom(b"TIMESTAMP")?;
            let multiple = atom(b"MULTIPLE")?;
            let atom_pair = atom(b"ATOM_PAIR")?;
            let incr = atom(b"INCR")?;
            let property = atom(b"_BUN_NATIVE_TEST_CLIPBOARD")?;
            let window = connection.generate_id()?;
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
                )?
                .check()?;
            Ok(Self {
                connection,
                window,
                clipboard,
                utf8,
                targets,
                timestamp,
                multiple,
                atom_pair,
                incr,
                property,
                nonce,
                stop: directory.join(format!("clipboard-{label}.stop")),
                label,
                deadline: Instant::now() + Duration::from_secs(12),
                log_bytes: 0,
            })
        }

        fn emit(&mut self, value: Value) -> Result<()> {
            let mut object = value
                .as_object()
                .ok_or("fixture record must be an object")?
                .clone();
            object.insert("nonce".into(), self.nonce.clone().into());
            object.insert("label".into(), self.label.clone().into());
            object.insert("pid".into(), std::process::id().into());
            let mut line = serde_json::to_vec(&object)?;
            line.push(b'\n');
            self.log_bytes += line.len();
            if self.log_bytes > 65_536 {
                return Err("clipboard peer evidence exceeded its bound".into());
            }
            io::stdout().lock().write_all(&line)?;
            Ok(())
        }

        fn active(&self) -> Result<bool> {
            if self.stop.exists() {
                return Ok(false);
            }
            if Instant::now() >= self.deadline {
                return Err("clipboard peer deadline expired".into());
            }
            Ok(true)
        }

        fn time(&self) -> Result<u32> {
            self.connection.change_property8(
                PropMode::APPEND,
                self.window,
                self.property,
                AtomEnum::INTEGER,
                &[],
            )?;
            self.connection.flush()?;
            while self.active()? {
                match self.connection.poll_for_event()? {
                    Some(Event::PropertyNotify(event))
                        if event.window == self.window && event.atom == self.property =>
                    {
                        return Ok(event.time);
                    }
                    _ => std::thread::sleep(POLL),
                }
            }
            Err("clipboard peer was stopped before timestamp acquisition".into())
        }

        fn notify(&self, request: &SelectionRequestEvent, property: Atom) -> Result<()> {
            self.connection.send_event(
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
            )?;
            self.connection.flush()?;
            Ok(())
        }

        fn read(mut self) -> Result<()> {
            let owner = self
                .connection
                .get_selection_owner(self.clipboard)?
                .reply()?
                .owner;
            if owner == x11rb::NONE {
                return self.emit(json!({"type":"read", "owner":owner, "result":{"kind":"empty"}}));
            }
            let time = self.time()?;
            self.connection
                .delete_property(self.window, self.property)?;
            self.connection.convert_selection(
                self.window,
                self.clipboard,
                self.utf8,
                self.property,
                time,
            )?;
            self.connection.flush()?;
            while self.active()? {
                match self.connection.poll_for_event()? {
                    Some(Event::SelectionNotify(event)) => {
                        if event.requestor != self.window
                            || event.selection != self.clipboard
                            || event.target != self.utf8
                            || event.time != time
                            || event.property != self.property
                        {
                            return Err(
                                "clipboard reader received a mismatched selection reply".into()
                            );
                        }
                        let reply = self
                            .connection
                            .get_property(true, self.window, self.property, AtomEnum::ANY, 0, 4096)?
                            .reply()?;
                        if reply.type_ != self.utf8
                            || reply.format != 8
                            || reply.bytes_after != 0
                            || reply.value.len() > MAX_TEXT
                        {
                            return Err(
                                "clipboard reader received an invalid or oversized text property"
                                    .into(),
                            );
                        }
                        let text = String::from_utf8(reply.value)?;
                        if text.contains('\0')
                            || self
                                .connection
                                .get_selection_owner(self.clipboard)?
                                .reply()?
                                .owner
                                != owner
                        {
                            return Err("clipboard reader owner or payload changed".into());
                        }
                        return self.emit(json!({"type":"read", "owner":owner, "requestor":self.window, "result":{"kind":"text","text":text}}));
                    }
                    _ => std::thread::sleep(POLL),
                }
            }
            Err("clipboard reader stopped before a response".into())
        }

        fn malformed_multiple(mut self) -> Result<()> {
            let time = self.time()?;
            self.connection.change_property8(
                PropMode::REPLACE,
                self.window,
                self.property,
                self.atom_pair,
                &[0; 16],
            )?;
            self.connection.convert_selection(
                self.window,
                self.clipboard,
                self.multiple,
                self.property,
                time,
            )?;
            self.connection.flush()?;
            while self.active()? {
                match self.connection.poll_for_event()? {
                    Some(Event::SelectionNotify(event)) => {
                        if event.requestor != self.window
                            || event.selection != self.clipboard
                            || event.target != self.multiple
                            || event.time != time
                            || event.property != x11rb::NONE
                        {
                            return Err(
                                "malformed format-8 ATOM_PAIR was not explicitly rejected".into()
                            );
                        }
                        return self.emit(json!({"type":"multiple-rejected","suppliedFormat":8,"property":event.property}));
                    }
                    _ => std::thread::sleep(POLL),
                }
            }
            Err("malformed MULTIPLE request received no rejection".into())
        }

        fn own(mut self, mode: &str, text: String) -> Result<()> {
            if text.len() > MAX_TEXT || text.contains('\0') {
                return Err("fixture text exceeds its bound".into());
            }
            let bytes = match mode {
                "text" | "delayed" | "incr" | "slow-incr" | "stall" | "drop" | "flood" => {
                    text.into_bytes()
                }
                "oversize" | "incr-oversize" | "incr-header-large" => vec![b'x'; MAX_TEXT + 1],
                "invalid-utf8" => vec![0xff],
                "nul" => b"invalid\0text".to_vec(),
                _ => return Err("unknown clipboard owner mode".into()),
            };
            let timestamp = self.time()?;
            self.connection
                .set_selection_owner(self.window, self.clipboard, timestamp)?
                .check()?;
            if self
                .connection
                .get_selection_owner(self.clipboard)?
                .reply()?
                .owner
                != self.window
            {
                return Err("clipboard owner was not installed on the X server".into());
            }
            self.emit(
                json!({"type":"ready","mode":mode,"window":self.window,"timestamp":timestamp}),
            )?;
            let mut transfer: Option<Transfer> = None;
            let mut request_count = 0;
            while self.active()? {
                while let Some(event) = self.connection.poll_for_event()? {
                    match event {
                        Event::SelectionRequest(request) if request.selection == self.clipboard => {
                            let property = if request.property == x11rb::NONE {
                                request.target
                            } else {
                                request.property
                            };
                            if request.target == self.targets {
                                self.connection.change_property32(
                                    PropMode::REPLACE,
                                    request.requestor,
                                    property,
                                    AtomEnum::ATOM,
                                    &[self.utf8, self.targets, self.timestamp],
                                )?;
                                self.notify(&request, property)?;
                            } else if request.target == self.timestamp {
                                self.connection.change_property32(
                                    PropMode::REPLACE,
                                    request.requestor,
                                    property,
                                    AtomEnum::INTEGER,
                                    &[timestamp],
                                )?;
                                self.notify(&request, property)?;
                            } else if request.target != self.utf8 || transfer.is_some() {
                                self.notify(&request, x11rb::NONE)?;
                            } else {
                                request_count += 1;
                                if request_count > 16 {
                                    return Err(
                                        "clipboard peer request count exceeded its bound".into()
                                    );
                                }
                                self.emit(json!({"type":"requested","request":request_count,"requestor":request.requestor,"mode":mode}))?;
                                if mode == "drop" {
                                    return self.emit(json!({"type":"owner-dropped"}));
                                }
                                if mode == "stall" {
                                    continue;
                                }
                                if mode == "flood" {
                                    // Bounded hostile external input: these
                                    // irrelevant events must not bypass the
                                    // host's pre-parser inbound byte budget.
                                    for _ in 0..12_288 {
                                        self.connection.send_event(
                                            false,
                                            request.requestor,
                                            EventMask::NO_EVENT,
                                            xproto::PropertyNotifyEvent {
                                                response_type: xproto::PROPERTY_NOTIFY_EVENT,
                                                sequence: 0,
                                                window: request.requestor,
                                                atom: property,
                                                time: request.time,
                                                state: Property::NEW_VALUE,
                                            },
                                        )?;
                                    }
                                    self.connection.flush()?;
                                    self.emit(json!({"type":"flood-sent","events":12_288,"eventBytes":393_216}))?;
                                    continue;
                                }
                                let incremental = matches!(
                                    mode,
                                    "incr" | "slow-incr" | "incr-oversize" | "incr-header-large"
                                );
                                let mut pending = Transfer {
                                    request,
                                    property,
                                    next: 0,
                                    due: None,
                                    incremental,
                                };
                                if incremental {
                                    self.connection.change_window_attributes(
                                        request.requestor,
                                        &xproto::ChangeWindowAttributesAux::new()
                                            .event_mask(EventMask::PROPERTY_CHANGE),
                                    )?;
                                    let lower_bound = if mode == "incr-header-large" {
                                        MAX_TEXT as u32 + 1
                                    } else {
                                        1
                                    };
                                    self.connection.change_property32(
                                        PropMode::REPLACE,
                                        request.requestor,
                                        property,
                                        self.incr,
                                        &[lower_bound],
                                    )?;
                                    self.notify(&request, property)?;
                                } else {
                                    pending.due = Some(
                                        Instant::now()
                                            + if mode == "delayed" {
                                                Duration::from_millis(150)
                                            } else {
                                                Duration::ZERO
                                            },
                                    );
                                }
                                transfer = Some(pending);
                            }
                        }
                        Event::PropertyNotify(event) => {
                            if let Some(pending) = &mut transfer
                                && pending.incremental
                                && event.window == pending.request.requestor
                                && event.atom == pending.property
                                && event.state == Property::DELETE
                            {
                                pending.due = Some(
                                    Instant::now()
                                        + if mode == "slow-incr" {
                                            Duration::from_millis(400)
                                        } else {
                                            Duration::from_millis(15)
                                        },
                                );
                            }
                        }
                        Event::SelectionClear(_) => {
                            self.emit(json!({"type":"selection-lost"}))?;
                        }
                        _ => {}
                    }
                }
                if transfer
                    .as_ref()
                    .is_some_and(|pending| pending.due.is_some_and(|time| time <= Instant::now()))
                {
                    let mut pending = transfer.take().ok_or("pending transfer disappeared")?;
                    let end = if pending.incremental {
                        (pending.next + if mode == "slow-incr" { 4 } else { 256 }).min(bytes.len())
                    } else {
                        bytes.len()
                    };
                    let chunk = &bytes[pending.next..end];
                    let sent = self
                        .connection
                        .change_property8(
                            PropMode::REPLACE,
                            pending.request.requestor,
                            pending.property,
                            self.utf8,
                            chunk,
                        )?
                        .check();
                    if sent.is_err() {
                        self.emit(json!({"type":"requestor-gone"}))?;
                    } else if pending.incremental && !chunk.is_empty() {
                        pending.next = end;
                        pending.due = None;
                        self.emit(json!({"type":"chunk","bytes":chunk.len(),"total":end}))?;
                        transfer = Some(pending);
                    } else {
                        if !pending.incremental {
                            self.notify(&pending.request, pending.property)?;
                        }
                        self.emit(json!({"type":"served","bytes":bytes.len(),"incremental":pending.incremental}))?;
                    }
                    self.connection.flush()?;
                }
                std::thread::sleep(POLL);
            }
            self.emit(json!({"type":"stopped","requests":request_count}))
        }
    }

    struct Transfer {
        request: SelectionRequestEvent,
        property: Atom,
        next: usize,
        due: Option<Instant>,
        incremental: bool,
    }

    pub(super) fn run() -> Result<()> {
        let arguments: Vec<_> = std::env::args().skip(1).collect();
        match arguments.as_slice() {
            [role, label] if role == "read" => Peer::new(label.clone())?.read(),
            [role, label] if role == "malformed-multiple" => Peer::new(label.clone())?.malformed_multiple(),
            [role, label, mode, text] if role == "owner" => Peer::new(label.clone())?.own(mode, text.clone()),
            _ => Err("usage: clipboard-peer read LABEL | malformed-multiple LABEL | owner LABEL MODE TEXT".into()),
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    return linux::run();
    #[cfg(not(target_os = "linux"))]
    Err("the isolated clipboard peer supports Linux X11 only".into())
}
