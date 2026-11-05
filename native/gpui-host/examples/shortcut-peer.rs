//! Independent X11 client that holds one passive root key grab, so the native
//! global shortcut test can observe a real OS-level conflict and a real release.
//! Never run against a personal display; the test owns its isolated Xvfb.
//!
//! Usage: shortcut-peer KEYSYM_HEX MODIFIER_MASK
//! Prints `grabbed` or `conflict`, then holds the grab until stdin closes.

#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::io::{Read, Write};
    use x11rb::connection::Connection;
    use x11rb::errors::ReplyError;
    use x11rb::protocol::ErrorKind;
    use x11rb::protocol::xproto::{ConnectionExt, GrabMode, ModMask};

    let mut arguments = std::env::args().skip(1);
    let keysym = u32::from_str_radix(arguments.next().ok_or("missing keysym")?.as_str(), 16)?;
    let mask: u16 = arguments.next().ok_or("missing modifier mask")?.parse()?;
    let (connection, screen) = x11rb::connect(None)?;
    let root = connection.setup().roots[screen].root;
    let (minimum, maximum) = (
        connection.setup().min_keycode,
        connection.setup().max_keycode,
    );
    let mapping = connection
        .get_keyboard_mapping(minimum, maximum - minimum + 1)?
        .reply()?;
    let width = usize::from(mapping.keysyms_per_keycode);
    let keycode = mapping
        .keysyms
        .chunks(width)
        .position(|row| row.first() == Some(&keysym))
        .ok_or("keysym is not on the keyboard map")? as u8
        + minimum;
    let outcome = match connection
        .grab_key(
            false,
            root,
            ModMask::from(mask),
            keycode,
            GrabMode::ASYNC,
            GrabMode::ASYNC,
        )?
        .check()
    {
        Ok(()) => "grabbed",
        Err(ReplyError::X11Error(error)) if error.error_kind == ErrorKind::Access => "conflict",
        Err(error) => return Err(error.into()),
    };
    let mut stdout = std::io::stdout();
    writeln!(stdout, "{outcome}")?;
    stdout.flush()?;
    // Hold the grab (or the failed attempt) until the owner closes stdin.
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
    drop(connection);
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("shortcut-peer requires a local X11 session");
    std::process::exit(2);
}
