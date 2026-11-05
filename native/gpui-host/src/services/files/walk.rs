//! macOS: no `openat2`, so the path is walked one validated name at a time,
//! each step an `openat` relative to the descriptor the previous step
//! returned, starting at the grant's directory descriptor.
//!
//! Every name is a single directory entry (validation forbids `/`, `.`, `..`
//! and empty names), so no step can name anything but a direct child of a
//! directory already reached from the grant. `O_NOFOLLOW` refuses a link as
//! the opened name, and on macOS 11 and later `O_NOFOLLOW_ANY` additionally
//! makes the kernel refuse a link anywhere in the step's resolution. Each
//! intermediate step also opens with `O_DIRECTORY`, so an entry swapped for a
//! file or link between requests fails instead of being traversed. As with
//! Linux `RESOLVE_BENEATH` (which only guards `..` and absolute names), a
//! directory renamed out of the grant while a walk holds its descriptor stays
//! the directory that was opened; no path text is ever resolved again.
//!
//! Directories are opened `O_RDONLY | O_DIRECTORY`, so on macOS an
//! intermediate directory must be readable as well as searchable.
//!
//! Linux compiles this walk only for tests, without `O_NOFOLLOW_ANY`, so the
//! per-component logic runs against real files on every Linux test run.

use super::Confine;
use rustix::fs::{AtFlags, CWD, FileType, Mode, OFlags, openat, statat};
use rustix::io::Errno;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};

#[cfg(target_os = "macos")]
const NO_LINKS: OFlags = OFlags::NOFOLLOW.union(OFlags::NOFOLLOW_ANY);
#[cfg(not(target_os = "macos"))]
const NO_LINKS: OFlags = OFlags::NOFOLLOW;

const DIRECTORY: OFlags = OFlags::RDONLY.union(OFlags::DIRECTORY);

pub(crate) struct Walk;

/// Opens one name beneath `directory` without following a link.
fn step(
    directory: BorrowedFd<'_>,
    name: &str,
    flags: OFlags,
    mode: Mode,
) -> Result<OwnedFd, Errno> {
    let flags = flags | NO_LINKS | OFlags::CLOEXEC | OFlags::NOCTTY;
    openat(directory, name, flags, mode).map_err(|error| {
        // A link opened with O_DIRECTORY may report ENOTDIR rather than ELOOP;
        // report every link refusal the same way.
        let link = error == Errno::NOTDIR
            && statat(directory, name, AtFlags::SYMLINK_NOFOLLOW)
                .is_ok_and(|stat| FileType::from_raw_mode(stat.st_mode) == FileType::Symlink);
        if link { Errno::LOOP } else { error }
    })
}

impl Confine for Walk {
    fn probe() -> bool {
        openat(
            CWD,
            "/",
            DIRECTORY | NO_LINKS | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .is_ok()
    }

    fn open_root(path: &str) -> Result<OwnedFd, Errno> {
        rustix::fs::open(path, DIRECTORY | OFlags::CLOEXEC, Mode::empty())
    }

    fn beneath(root: &OwnedFd, path: &str, flags: OFlags, mode: Mode) -> Result<OwnedFd, Errno> {
        if path.is_empty() {
            // "." names the grant directory itself and resolves no link.
            return step(root.as_fd(), ".", flags, mode);
        }
        let (directory, name) = path.rsplit_once('/').unwrap_or(("", path));
        if directory.is_empty() {
            step(root.as_fd(), name, flags, mode)
        } else {
            step(Self::directory(root, directory)?.as_fd(), name, flags, mode)
        }
    }

    fn directory(root: &OwnedFd, path: &str) -> Result<OwnedFd, Errno> {
        let mut names = path.split('/').filter(|name| !name.is_empty());
        let Some(first) = names.next() else {
            return step(root.as_fd(), ".", DIRECTORY, Mode::empty());
        };
        let mut current = step(root.as_fd(), first, DIRECTORY, Mode::empty())?;
        for name in names {
            current = step(current.as_fd(), name, DIRECTORY, Mode::empty())?;
        }
        Ok(current)
    }
}
