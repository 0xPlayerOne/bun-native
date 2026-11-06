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

#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    peer::run()
}

#[cfg(target_os = "linux")]
mod peer {
    use std::io::{BufRead, Write};
    use std::time::Instant;
    use wayland_client::globals::{GlobalListContents, registry_queue_init};
    use wayland_client::protocol::wl_pointer::ButtonState;
    use wayland_client::protocol::{wl_registry, wl_seat};
    use wayland_client::{Connection, Dispatch, QueueHandle, delegate_noop};
    use wayland_protocols_wlr::virtual_pointer::v1::client::{
        zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1,
        zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1,
    };

    /// linux/input-event-codes.h BTN_LEFT.
    const BTN_LEFT: u32 = 0x110;

    struct State;

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
    delegate_noop!(State: ignore wl_seat::WlSeat);
    delegate_noop!(State: ZwlrVirtualPointerManagerV1);
    delegate_noop!(State: ZwlrVirtualPointerV1);

    pub(super) fn run() -> Result<(), Box<dyn std::error::Error>> {
        let connection = Connection::connect_to_env()?;
        let (globals, mut queue) = registry_queue_init::<State>(&connection)?;
        let handle = queue.handle();
        let seat: wl_seat::WlSeat = globals.bind(&handle, 1..=1, ())?;
        let manager: ZwlrVirtualPointerManagerV1 = globals.bind(&handle, 1..=1, ())?;
        let pointer = manager.create_virtual_pointer(Some(&seat), &handle, ());
        queue.roundtrip(&mut State)?;
        let started = Instant::now();
        let time = || u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "ready")?;
        stdout.flush()?;
        for line in std::io::stdin().lock().lines() {
            let line = line?;
            let words: Vec<&str> = line.split_whitespace().collect();
            let result: Result<(), String> = match words.as_slice() {
                ["move", x, y, width, height] => {
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
                ["press"] => {
                    pointer.button(time(), BTN_LEFT, ButtonState::Pressed);
                    pointer.frame();
                    Ok(())
                }
                ["release"] => {
                    pointer.button(time(), BTN_LEFT, ButtonState::Released);
                    pointer.frame();
                    Ok(())
                }
                _ => Err("unknown command".into()),
            };
            // The compositor has processed the request once the round trip returns.
            queue.roundtrip(&mut State)?;
            match result {
                Ok(()) => writeln!(stdout, "ok")?,
                Err(message) => writeln!(stdout, "error: {message}")?,
            }
            stdout.flush()?;
        }
        pointer.destroy();
        manager.destroy();
        queue.roundtrip(&mut State)?;
        Ok(())
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("wayland-input-peer drives a Linux Wayland compositor only");
    std::process::exit(2);
}
