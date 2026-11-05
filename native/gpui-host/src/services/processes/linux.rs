//! Linux: an eventfd wakes the supervisor, a pidfd reports the leader's exit
//! and the child starts in the grant descriptor itself.

use super::Failure;
use crate::services::files::{Directory, beneath, failure as path_failure};
use bun_native_protocol::ErrorCode;
use rustix::event::{EventfdFlags, eventfd};
use rustix::fs::{Mode, OFlags};
use rustix::io::Errno;
use rustix::process::{Pid, PidfdFlags, WaitId, WaitIdOptions, pidfd_open, waitid};
use std::os::fd::{AsFd, AsRawFd as _, BorrowedFd, OwnedFd};

/// pidfd (Linux 5.3) observes exit without a signal handler; filesystem
/// grants already require 5.6.
pub(super) fn available() -> bool {
    pidfd_open(rustix::process::getpid(), PidfdFlags::empty()).is_ok()
}

pub(super) const UNAVAILABLE: &str = "owned processes require Linux pidfd support";

pub(super) struct Wake(OwnedFd);

impl Wake {
    pub(super) fn new() -> std::io::Result<Self> {
        Ok(Self(eventfd(
            0,
            EventfdFlags::CLOEXEC | EventfdFlags::NONBLOCK,
        )?))
    }

    pub(super) fn notify(&self) {
        let _ = rustix::io::write(&self.0, &1u64.to_ne_bytes());
    }

    pub(super) fn drain(&self) {
        let mut value = [0; 8];
        let _ = rustix::io::read(&self.0, &mut value);
    }
}

impl AsFd for Wake {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.0.as_fd()
    }
}

/// Readable once the leader has exited; the leader is never reaped through it.
pub(super) struct ExitWatch(OwnedFd);

impl ExitWatch {
    pub(super) fn new(pid: Pid) -> Result<Self, Failure> {
        pidfd_open(pid, PidfdFlags::empty())
            .map(Self)
            .map_err(|_| (ErrorCode::NativeFailure, "cannot observe the process"))
    }

    /// True once the leader is a zombie that still holds its group ID.
    pub(super) fn exited(&self) -> bool {
        matches!(
            waitid(
                WaitId::PidFd(self.0.as_fd()),
                WaitIdOptions::EXITED | WaitIdOptions::NOWAIT | WaitIdOptions::NOHANG,
            ),
            Ok(Some(_))
        )
    }

    /// The pidfd holds nothing that must end before the leader is reaped.
    pub(super) fn finish(&mut self) {}
}

impl AsFd for ExitWatch {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.0.as_fd()
    }
}

/// The opened directory the child starts in, and the path that names that
/// open descriptor (not the directory's own path) for `Command::current_dir`.
pub(super) fn working_directory(
    directory: Option<&(Directory, String)>,
) -> Result<Option<(OwnedFd, String)>, Failure> {
    let Some((root, path)) = directory else {
        return Ok(None);
    };
    let fd = beneath(root, path, OFlags::PATH | OFlags::DIRECTORY, Mode::empty()).map_err(
        |failure| match failure.0 {
            ErrorCode::NotFound | ErrorCode::WrongKind | ErrorCode::PathDenied => failure,
            _ => path_failure(Errno::ACCESS),
        },
    )?;
    let cwd = format!("/proc/self/fd/{}", fd.as_raw_fd());
    Ok(Some((fd, cwd)))
}
