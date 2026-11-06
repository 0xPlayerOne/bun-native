//! Linux: the kernel resolves the whole relative path beneath the grant with
//! `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)`.

use super::Confine;
use rustix::fs::{CWD, Mode, OFlags, ResolveFlags, openat2};
use rustix::io::Errno;
use std::os::fd::OwnedFd;

const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_MAGICLINKS);

pub(crate) struct Openat2;

impl Confine for Openat2 {
    fn probe() -> bool {
        // openat2 arrived in Linux 5.6; without it confinement cannot be enforced.
        openat2(
            CWD,
            ".",
            OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            RESOLVE,
        )
        .is_ok()
    }

    fn open_root(path: &str) -> Result<OwnedFd, Errno> {
        rustix::fs::open(
            path,
            OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
    }

    fn beneath(root: &OwnedFd, path: &str, flags: OFlags, mode: Mode) -> Result<OwnedFd, Errno> {
        let path = if path.is_empty() { "." } else { path };
        // openat2 rejects O_PATH combined with anything but these flags.
        let flags = if flags.contains(OFlags::PATH) {
            flags | OFlags::CLOEXEC
        } else {
            flags | OFlags::CLOEXEC | OFlags::NOCTTY
        };
        // A concurrent rename can make the kernel ask for a retry.
        match openat2(root, path, flags, mode, RESOLVE) {
            Err(Errno::AGAIN) => openat2(root, path, flags, mode, RESOLVE),
            result => result,
        }
    }

    fn directory(root: &OwnedFd, path: &str) -> Result<OwnedFd, Errno> {
        Self::beneath(root, path, OFlags::PATH | OFlags::DIRECTORY, Mode::empty())
    }
}
