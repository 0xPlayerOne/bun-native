//! Linux: an eventfd wakes the supervisor, a pidfd reports the leader's exit
//! and the child starts in the grant descriptor itself.

use super::Failure;
use crate::services::files::{Directory, directory_beneath, failure as path_failure};
use bun_native_protocol::ErrorCode;
use rustix::event::{EventfdFlags, eventfd};
use rustix::io::Errno;
use rustix::process::{Pid, PidfdFlags, WaitId, WaitIdOptions, pidfd_open, waitid};
use std::os::fd::{AsFd, AsRawFd as _, BorrowedFd, OwnedFd};
use std::process::Command;

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

/// The opened directory the child starts in.
pub(super) fn working_directory(
    directory: Option<&(Directory, String)>,
) -> Result<Option<OwnedFd>, Failure> {
    let Some((root, path)) = directory else {
        return Ok(None);
    };
    directory_beneath(root, path)
        .map(Some)
        .map_err(|failure| match failure.0 {
            ErrorCode::NotFound | ErrorCode::WrongKind | ErrorCode::PathDenied => failure,
            _ => path_failure(Errno::ACCESS),
        })
}

/// The path that names the open descriptor (not the directory's own path),
/// for `Command::current_dir`.
fn descriptor_path(directory: &OwnedFd) -> String {
    format!("/proc/self/fd/{}", directory.as_raw_fd())
}

pub(super) fn start_in(command: &mut Command, directory: &OwnedFd) -> Result<(), Failure> {
    command.current_dir(descriptor_path(directory));
    Ok(())
}

pub(super) fn start_in_terminal(
    command: pty_process::blocking::Command,
    directory: &OwnedFd,
) -> Result<pty_process::blocking::Command, Failure> {
    Ok(command.current_dir(descriptor_path(directory)))
}
