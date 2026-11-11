//! Independent Wayland input device for the native Wayland test. It creates
//! one `zwlr_virtual_pointer_v1` on the compositor's seat and keeps it for its
//! whole life, so the seat keeps a pointer capability and clients keep their
//! `wl_pointer`. Motion and buttons then reach the focused client through the
//! compositor's normal cursor and seat path, as from a physical mouse.
//! Short-lived tools such as wlrctl add and remove their device per command,
//! which races the client's rebinding of `wl_pointer`.
//! Never run against a personal session; the test owns its headless compositor.
//!
//! Commands, one per stdin line; each prints one line, `ok` or `error: ...`:
//!   move X Y W H   absolute motion to X,Y within a W x H output layout
//!   press          left button down
//!   release        left button up
//!
//! It is also the seat's one input method (`zwp_input_method_v2`), created on
//! the first `ime-` command, so text reaches the focused client's
//! `zwp_text_input_v3` through the compositor as from an IME engine:
//!   ime-active          wait (bounded) until the compositor activates the
//!                       input method for a focused text input
//!   ime-inactive        wait (bounded) until the compositor deactivates it
//!   ime-preedit B E T   preedit T (rest of the line), cursor at bytes B..E
//!   ime-commit T        commit T (rest of the line), ending any preedit
//!   ime-clear           an empty preedit, cancelling the composition
//!   ime-state           `ok active=<0|1> serial=<done events>`
//!
//! Each wait and each input-method commit first reads every event the
//! compositor sent before the command, so it never answers from a stale state,
//! and commits carry the serial of the latest `done`: wlroots drops a commit
//! with an older one.

#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    peer::run()
}

#[cfg(target_os = "linux")]
mod peer {
    use std::io::{BufRead, Write};
    use std::time::{Duration, Instant};
    use wayland_client::globals::{GlobalListContents, registry_queue_init};
    use wayland_client::protocol::wl_pointer::ButtonState;
    use wayland_client::protocol::{wl_registry, wl_seat};
    use wayland_client::{Connection, Dispatch, QueueHandle, delegate_noop};
    use wayland_protocols_misc::zwp_input_method_v2::client::{
        zwp_input_method_manager_v2::ZwpInputMethodManagerV2,
        zwp_input_method_v2::{self, ZwpInputMethodV2},
    };
    use wayland_protocols_wlr::virtual_pointer::v1::client::{
        zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1,
        zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1,
    };

    /// linux/input-event-codes.h BTN_LEFT.
    const BTN_LEFT: u32 = 0x110;

    /// What the compositor has told the input method. Activation takes effect
    /// on `done`, which also counts the serial every commit must carry.
    #[derive(Default)]
    struct State {
        pending_active: bool,
        active: bool,
        serial: u32,
        unavailable: bool,
    }

    impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
        fn event(
            _: &mut Self,
            _: &wl_registry::WlRegistry,
            _: wl_registry::Event,
            _: &GlobalListContents,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    impl Dispatch<ZwpInputMethodV2, ()> for State {
        fn event(
            state: &mut Self,
            _: &ZwpInputMethodV2,
            event: zwp_input_method_v2::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            match event {
                zwp_input_method_v2::Event::Activate => state.pending_active = true,
                zwp_input_method_v2::Event::Deactivate => state.pending_active = false,
                zwp_input_method_v2::Event::Done => {
                    state.active = state.pending_active;
                    state.serial = state.serial.wrapping_add(1);
                }
                zwp_input_method_v2::Event::Unavailable => state.unavailable = true,
                _ => {}
            }
        }
    }
    delegate_noop!(State: ignore wl_seat::WlSeat);
    delegate_noop!(State: ZwpInputMethodManagerV2);
    delegate_noop!(State: ZwlrVirtualPointerManagerV1);
    delegate_noop!(State: ZwlrVirtualPointerV1);

    /// The text after the first `count` space-separated words of a line.
    fn rest(line: &str, count: usize) -> String {
        line.splitn(count + 1, ' ')
            .nth(count)
            .unwrap_or("")
            .to_owned()
    }

    pub(super) fn run() -> Result<(), Box<dyn std::error::Error>> {
        let connection = Connection::connect_to_env()?;
        let (globals, mut queue) = registry_queue_init::<State>(&connection)?;
        let handle = queue.handle();
        let seat: wl_seat::WlSeat = globals.bind(&handle, 1..=1, ())?;
        let manager: ZwlrVirtualPointerManagerV1 = globals.bind(&handle, 1..=1, ())?;
        let pointer = manager.create_virtual_pointer(Some(&seat), &handle, ());
        let mut state = State::default();
        queue.roundtrip(&mut state)?;
        let mut input_method: Option<ZwpInputMethodV2> = None;
        let started = Instant::now();
        let time = || u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "ready")?;
        stdout.flush()?;
        for line in std::io::stdin().lock().lines() {
            let line = line?;
            let words: Vec<&str> = line.split_whitespace().collect();
            let ime = words.first().is_some_and(|word| word.starts_with("ime-"));
            if ime && input_method.is_none() {
                match globals.bind::<ZwpInputMethodManagerV2, _, _>(&handle, 1..=1, ()) {
                    Ok(manager) => {
                        input_method = Some(manager.get_input_method(&seat, &handle, ()));
                        queue.roundtrip(&mut state)?;
                    }
                    Err(error) => {
                        writeln!(stdout, "error: no input method manager: {error}")?;
                        stdout.flush()?;
                        continue;
                    }
                }
            }
            // A client's own text-input commit, such as a new cursor rectangle
            // after it applied a preedit, makes the compositor send another
            // `done`. A real input method has read it before it commits again,
            // so read every event sent so far before an input-method commit.
            if matches!(
                words.first(),
                Some(&("ime-preedit" | "ime-commit" | "ime-clear"))
            ) && input_method.is_some()
            {
                queue.roundtrip(&mut state)?;
            }
            let result: Result<(), String> = match (words.as_slice(), input_method.as_ref()) {
                ([command @ ("ime-active" | "ime-inactive")], Some(_)) => {
                    let want = *command == "ime-active";
                    let deadline = Instant::now() + Duration::from_secs(5);
                    queue.roundtrip(&mut state)?;
                    while state.active != want && !state.unavailable && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(20));
                        queue.roundtrip(&mut state)?;
                    }
                    if state.unavailable {
                        Err("the seat already has an input method".into())
                    } else if state.active == want {
                        Ok(())
                    } else if want {
                        Err("the input method was never activated".into())
                    } else {
                        Err("the input method was never deactivated".into())
                    }
                }
                (["ime-preedit", begin, end, ..], Some(method)) => {
                    match (begin.parse::<i32>(), end.parse::<i32>()) {
                        (Ok(begin), Ok(end)) => {
                            method.set_preedit_string(rest(&line, 3), begin, end);
                            method.commit(state.serial);
                            Ok(())
                        }
                        _ => Err("invalid preedit cursor".into()),
                    }
                }
                (["ime-commit", ..], Some(method)) => {
                    method.commit_string(rest(&line, 1));
                    method.commit(state.serial);
                    Ok(())
                }
                (["ime-clear"], Some(method)) => {
                    method.set_preedit_string(String::new(), 0, 0);
                    method.commit(state.serial);
                    Ok(())
                }
                (["ime-state"], Some(_)) => Ok(()),
                (["move", x, y, width, height], _) => {
                    let parse = |value: &str| value.parse::<u32>().map_err(|e| e.to_string());
                    match (parse(x), parse(y), parse(width), parse(height)) {
                        (Ok(x), Ok(y), Ok(width), Ok(height)) if x < width && y < height => {
                            pointer.motion_absolute(time(), x, y, width, height);
                            pointer.frame();
                            Ok(())
                        }
                        _ => Err("invalid move".into()),
                    }
                }
                (["press"], _) => {
                    pointer.button(time(), BTN_LEFT, ButtonState::Pressed);
                    pointer.frame();
                    Ok(())
                }
                (["release"], _) => {
                    pointer.button(time(), BTN_LEFT, ButtonState::Released);
                    pointer.frame();
                    Ok(())
                }
                _ => Err("unknown command".into()),
            };
            // The compositor has processed the request once the round trip returns.
            queue.roundtrip(&mut state)?;
            match result {
                Ok(()) if words.first() == Some(&"ime-state") => writeln!(
                    stdout,
                    "ok active={} serial={}",
                    u8::from(state.active),
                    state.serial
                )?,
                Ok(()) => writeln!(stdout, "ok")?,
                Err(message) => writeln!(stdout, "error: {message}")?,
            }
            stdout.flush()?;
        }
        if let Some(method) = input_method {
            method.destroy();
        }
        pointer.destroy();
        manager.destroy();
        queue.roundtrip(&mut state)?;
        Ok(())
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("wayland-input-peer drives a Linux Wayland compositor only");
    std::process::exit(2);
}
