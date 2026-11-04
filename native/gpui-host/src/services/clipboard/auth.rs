//! Bounded, same-file adaptation of x11rb-protocol 0.13.2's xauth parser.
//! Copyright 2019 x11rb Contributers. MIT license: ../../../LICENSE-MIT-x11rb.
//! Upstream matching is preserved; setup reads one opened regular file instead
//! of reopening an environment path through the public get_auth API.

use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use x11rb::reexports::x11rb_protocol::xauth::Family;

const MAX_AUTH_BYTES: u64 = 1_048_576;
type AuthInfo = (Vec<u8>, Vec<u8>);

fn invalid() -> io::Error {
    // Authentication bytes and paths never enter errors or diagnostics.
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid bounded X11 authority file",
    )
}

pub(super) fn get(
    path: Option<&Path>,
    family: Family,
    address: &[u8],
    display: u16,
) -> io::Result<Option<AuthInfo>> {
    let Some(path) = path else { return Ok(None) };
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    select(&read_opened(file)?, family, address, display)
}

fn read_opened(file: File) -> io::Result<Vec<u8>> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_AUTH_BYTES {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    // The descriptor is retained across validation and reading. A concurrent
    // path replacement cannot substitute a pipe; growth remains byte-bounded.
    file.take(MAX_AUTH_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_AUTH_BYTES {
        return Err(invalid());
    }
    Ok(bytes)
}

fn number(input: &mut &[u8]) -> io::Result<u16> {
    let bytes: [u8; 2] = input
        .get(..2)
        .ok_or_else(invalid)?
        .try_into()
        .map_err(|_| invalid())?;
    *input = &input[2..];
    Ok(u16::from_be_bytes(bytes))
}

fn string<'a>(input: &mut &'a [u8]) -> io::Result<&'a [u8]> {
    let length = usize::from(number(input)?);
    let value = input.get(..length).ok_or_else(invalid)?;
    *input = &input[length..];
    Ok(value)
}

fn select(
    mut input: &[u8],
    family: Family,
    address: &[u8],
    display: u16,
) -> io::Result<Option<AuthInfo>> {
    let display = display.to_string();
    while !input.is_empty() {
        let entry_family = Family::from(number(&mut input)?);
        let entry_address = string(&mut input)?;
        let entry_number = string(&mut input)?;
        let name = string(&mut input)?;
        let data = string(&mut input)?;
        let address_matches = family == Family::WILD
            || entry_family == Family::WILD
            || (family == entry_family && address == entry_address);
        if address_matches
            && (entry_number.is_empty() || entry_number == display.as_bytes())
            && name == b"MIT-MAGIC-COOKIE-1"
        {
            return Ok(Some((name.to_vec(), data.to_vec())));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn entry(family: u16, address: &[u8], display: &[u8], name: &[u8]) -> Vec<u8> {
        let mut bytes = family.to_be_bytes().to_vec();
        for field in [address, display, name, b"synthetic-test-cookie"] {
            bytes.extend((field.len() as u16).to_be_bytes());
            bytes.extend(field);
        }
        bytes
    }

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "bun-native-authority-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn preserves_upstream_family_address_display_and_cookie_matching() {
        let good = entry(256, b"local-host", b"42", b"MIT-MAGIC-COOKIE-1");
        let expected = Some((
            b"MIT-MAGIC-COOKIE-1".to_vec(),
            b"synthetic-test-cookie".to_vec(),
        ));
        assert_eq!(
            select(&good, Family::LOCAL, b"local-host", 42).unwrap(),
            expected
        );
        assert_eq!(
            select(&good, Family::LOCAL, b"other-host", 42).unwrap(),
            None
        );
        assert_eq!(
            select(&good, Family::INTERNET, b"local-host", 42).unwrap(),
            None
        );
        assert_eq!(
            select(&good, Family::LOCAL, b"local-host", 43).unwrap(),
            None
        );
        let wildcard = entry(65535, b"any", b"", b"MIT-MAGIC-COOKIE-1");
        assert_eq!(
            select(&wildcard, Family::LOCAL, b"local-host", 42).unwrap(),
            expected
        );
        let wrong_method = entry(256, b"local-host", b"42", b"another-method");
        assert_eq!(
            select(&wrong_method, Family::LOCAL, b"local-host", 42).unwrap(),
            None
        );
        for end in 1..good.len() {
            assert!(select(&good[..end], Family::LOCAL, b"local-host", 42).is_err());
        }
    }

    #[test]
    fn rejects_pipes_and_oversize_files_and_retains_the_opened_inode() {
        let directory = Directory::new();
        let path = directory.0.join("authority");
        assert_eq!(get(Some(&path), Family::LOCAL, b"host", 1).unwrap(), None);
        rustix::fs::mkfifoat(
            rustix::fs::CWD,
            &path,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
        )
        .unwrap();
        assert!(get(Some(&path), Family::LOCAL, b"host", 1).is_err());
        std::fs::remove_file(&path).unwrap();
        let file = File::create(&path).unwrap();
        file.set_len(MAX_AUTH_BYTES + 1).unwrap();
        drop(file);
        assert!(get(Some(&path), Family::LOCAL, b"host", 1).is_err());
        std::fs::write(&path, b"original").unwrap();
        let opened = File::open(&path).unwrap();
        std::fs::rename(&path, directory.0.join("original")).unwrap();
        rustix::fs::mkfifoat(
            rustix::fs::CWD,
            &path,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
        )
        .unwrap();
        assert_eq!(read_opened(opened).unwrap(), b"original");
    }
}
