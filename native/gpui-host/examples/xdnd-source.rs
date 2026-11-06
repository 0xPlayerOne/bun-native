//! Independent X11 drag source speaking XDND version 5, so the native drag and
//! drop test exercises the X server and GPUI's real XDND target code instead of
//! a simulated GPUI event. It grabs the pointer like a real source, warps it
//! over the target and answers the target's selection conversion itself.
//! Never run against a personal display; the test owns its isolated Xvfb.
//!
//! Commands, one per stdin line; each prints one JSON line:
//!   find TITLE           locate the XdndAware window whose _NET_WM_NAME is TITLE
//!   offer TYPE JSON      offer JSON (a string) as `uri` (text/uri-list) or `text`
//!   enter X Y            grab, warp to window-relative X,Y, send Enter+Position
//!   move X Y             warp and send Position
//!   drop                 send Drop and wait for Finished
//!   leave                send Leave and release the grab

#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    source::run()
}

#[cfg(target_os = "linux")]
mod source {
    use std::io::{BufRead, Write};
    use std::time::{Duration, Instant};
    use x11rb::connection::Connection;
    use x11rb::protocol::Event;
    use x11rb::protocol::xproto::{
        Atom, AtomEnum, ClientMessageEvent, ConnectionExt, CreateWindowAux, EventMask, GrabMode,
        GrabStatus, PropMode, SELECTION_NOTIFY_EVENT, SelectionNotifyEvent, Window, WindowClass,
    };
    use x11rb::rust_connection::RustConnection;
    use x11rb::wrapper::ConnectionExt as _;
    use x11rb::{CURRENT_TIME, NONE};

    const WAIT: Duration = Duration::from_secs(2);

    struct Atoms {
        aware: Atom,
        enter: Atom,
        position: Atom,
        status: Atom,
        leave: Atom,
        drop: Atom,
        finished: Atom,
        selection: Atom,
        copy: Atom,
        name: Atom,
        utf8: Atom,
        uri: Atom,
        text: Atom,
    }

    struct Source {
        connection: RustConnection,
        root: Window,
        window: Window,
        atoms: Atoms,
        target: Option<Window>,
        offered: Atom,
        payload: Vec<u8>,
        conversions: usize,
        grabbed: bool,
    }

    pub(super) fn run() -> Result<(), Box<dyn std::error::Error>> {
        let (connection, screen) = x11rb::connect(None)?;
        let root = connection.setup().roots[screen].root;
        let intern = |name: &str| -> Result<Atom, Box<dyn std::error::Error>> {
            Ok(connection
                .intern_atom(false, name.as_bytes())?
                .reply()?
                .atom)
        };
        let atoms = Atoms {
            aware: intern("XdndAware")?,
            enter: intern("XdndEnter")?,
            position: intern("XdndPosition")?,
            status: intern("XdndStatus")?,
            leave: intern("XdndLeave")?,
            drop: intern("XdndDrop")?,
            finished: intern("XdndFinished")?,
            selection: intern("XdndSelection")?,
            copy: intern("XdndActionCopy")?,
            name: intern("_NET_WM_NAME")?,
            utf8: intern("UTF8_STRING")?,
            uri: intern("text/uri-list")?,
            text: intern("text/plain")?,
        };
        let window = connection.generate_id()?;
        // A viewable, off-screen, unmanaged window: it owns the selection and
        // the pointer grab, as a real drag source does.
        connection.create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            window,
            root,
            -16,
            -16,
            1,
            1,
            0,
            WindowClass::INPUT_OUTPUT,
            x11rb::COPY_FROM_PARENT,
            &CreateWindowAux::new().override_redirect(1),
        )?;
        connection.map_window(window)?;
        connection.flush()?;
        let offered = atoms.uri;
        let mut source = Source {
            connection,
            root,
            window,
            atoms,
            target: None,
            offered,
            payload: Vec::new(),
            conversions: 0,
            grabbed: false,
        };
        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout();
        for line in stdin.lock().lines() {
            let line = line?;
            let reply = source.command(&line)?;
            writeln!(stdout, "{reply}")?;
            stdout.flush()?;
        }
        Ok(())
    }

    impl Source {
        fn command(&mut self, line: &str) -> Result<String, Box<dyn std::error::Error>> {
            let (verb, rest) = line.split_once(' ').unwrap_or((line, ""));
            match verb {
                "find" => {
                    let target = self.find(self.root, rest)?;
                    self.target = target;
                    Ok(format!(r#"{{"found":{}}}"#, target.is_some()))
                }
                "offer" => {
                    let (kind, json) = rest.split_once(' ').ok_or("offer TYPE JSON")?;
                    self.offered = match kind {
                        "uri" => self.atoms.uri,
                        "text" => self.atoms.text,
                        _ => return Err("offer type must be uri or text".into()),
                    };
                    self.payload = serde_json::from_str::<String>(json)?.into_bytes();
                    Ok(format!(r#"{{"offered":{}}}"#, self.payload.len()))
                }
                "enter" | "move" => {
                    let (x, y) = rest.split_once(' ').ok_or("X Y")?;
                    let (x, y): (i16, i16) = (x.parse()?, y.parse()?);
                    let target = self.target.ok_or("no target window")?;
                    if verb == "enter" {
                        self.grab()?;
                        self.connection.set_selection_owner(
                            self.window,
                            self.atoms.selection,
                            CURRENT_TIME,
                        )?;
                        self.conversions = 0;
                        self.send(target, self.atoms.enter, [5 << 24, self.offered, 0, 0])?;
                    }
                    self.connection
                        .warp_pointer(NONE, target, 0, 0, 0, 0, x, y)?;
                    let at = self
                        .connection
                        .translate_coordinates(target, self.root, x, y)?
                        .reply()?;
                    let packed = (u32::from(at.dst_x as u16) << 16) | u32::from(at.dst_y as u16);
                    self.send(
                        target,
                        self.atoms.position,
                        [0, packed, CURRENT_TIME, self.atoms.copy],
                    )?;
                    let status = self.wait(self.atoms.status, verb == "enter")?;
                    Ok(match status {
                        Some(data) => format!(
                            r#"{{"status":{{"accepted":{},"copy":{}}},"conversions":{}}}"#,
                            data[1] & 1 == 1,
                            data[4] == self.atoms.copy,
                            self.conversions
                        ),
                        None => format!(r#"{{"status":null,"conversions":{}}}"#, self.conversions),
                    })
                }
                "drop" => {
                    let target = self.target.ok_or("no target window")?;
                    self.send(target, self.atoms.drop, [0, CURRENT_TIME, 0, 0])?;
                    let finished = self.wait(self.atoms.finished, false)?;
                    self.release()?;
                    Ok(match finished {
                        Some(data) => format!(
                            r#"{{"finished":{{"accepted":{},"copy":{}}}}}"#,
                            data[1] & 1 == 1,
                            data[2] == self.atoms.copy
                        ),
                        None => r#"{"finished":null}"#.into(),
                    })
                }
                "leave" => {
                    let target = self.target.ok_or("no target window")?;
                    self.send(target, self.atoms.leave, [0, 0, 0, 0])?;
                    self.release()?;
                    Ok(r#"{"left":true}"#.into())
                }
                _ => Err("unknown command".into()),
            }
        }

        fn grab(&mut self) -> Result<(), Box<dyn std::error::Error>> {
            let status = self
                .connection
                .grab_pointer(
                    false,
                    self.window,
                    EventMask::BUTTON_RELEASE | EventMask::POINTER_MOTION,
                    GrabMode::ASYNC,
                    GrabMode::ASYNC,
                    NONE,
                    NONE,
                    CURRENT_TIME,
                )?
                .reply()?
                .status;
            if status != GrabStatus::SUCCESS {
                return Err("drag source could not grab the pointer".into());
            }
            self.grabbed = true;
            Ok(())
        }

        fn release(&mut self) -> Result<(), Box<dyn std::error::Error>> {
            if std::mem::take(&mut self.grabbed) {
                self.connection.ungrab_pointer(CURRENT_TIME)?;
            }
            self.connection
                .set_selection_owner(NONE, self.atoms.selection, CURRENT_TIME)?;
            self.connection.flush()?;
            Ok(())
        }

        fn send(
            &self,
            target: Window,
            kind: Atom,
            data: [u32; 4],
        ) -> Result<(), Box<dyn std::error::Error>> {
            let event = ClientMessageEvent::new(
                32,
                target,
                kind,
                [self.window, data[0], data[1], data[2], data[3]],
            );
            self.connection
                .send_event(false, target, EventMask::NO_EVENT, event)?;
            self.connection.flush()?;
            Ok(())
        }

        /// Serve selection conversions until the expected reply (and, on
        /// entry, the target's first conversion) arrives, within the bound.
        fn wait(
            &mut self,
            kind: Atom,
            converted: bool,
        ) -> Result<Option<[u32; 5]>, Box<dyn std::error::Error>> {
            let deadline = Instant::now() + WAIT;
            let mut reply = None;
            while Instant::now() < deadline {
                if reply.is_some() && (!converted || self.conversions > 0) {
                    return Ok(reply);
                }
                let Some(event) = self.connection.poll_for_event()? else {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                };
                match event {
                    Event::ClientMessage(message) if message.type_ == kind => {
                        reply = Some(message.data.as_data32());
                    }
                    Event::SelectionRequest(request) => {
                        let property = if request.target == self.offered {
                            self.connection.change_property8(
                                PropMode::REPLACE,
                                request.requestor,
                                request.property,
                                request.target,
                                &self.payload,
                            )?;
                            self.conversions += 1;
                            request.property
                        } else {
                            NONE
                        };
                        let notify = SelectionNotifyEvent {
                            response_type: SELECTION_NOTIFY_EVENT,
                            sequence: 0,
                            time: request.time,
                            requestor: request.requestor,
                            selection: request.selection,
                            target: request.target,
                            property,
                        };
                        self.connection.send_event(
                            false,
                            request.requestor,
                            EventMask::NO_EVENT,
                            notify,
                        )?;
                        self.connection.flush()?;
                    }
                    _ => {}
                }
            }
            Ok(reply)
        }

        fn find(
            &self,
            window: Window,
            title: &str,
        ) -> Result<Option<Window>, Box<dyn std::error::Error>> {
            let name = self
                .connection
                .get_property(false, window, self.atoms.name, self.atoms.utf8, 0, 256)?
                .reply()?;
            let aware = self
                .connection
                .get_property(false, window, self.atoms.aware, AtomEnum::ANY, 0, 1)?
                .reply()?;
            if name.value == title.as_bytes() && aware.value_len > 0 {
                return Ok(Some(window));
            }
            for child in self.connection.query_tree(window)?.reply()?.children {
                if let Some(found) = self.find(child, title)? {
                    return Ok(Some(found));
                }
            }
            Ok(None)
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("xdnd-source requires a local X11 session");
    std::process::exit(2);
}
