use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt as _;

/// A NUL-terminated UTF-16 string; an embedded NUL would truncate it.
pub(crate) fn terminated(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = value.encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a Windows string contains NUL",
        ));
    }
    wide.push(0);
    Ok(wide)
}
