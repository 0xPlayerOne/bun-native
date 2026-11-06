//! macOS: no pidfd, eventfd or descriptor-relative working directory. A pipe
//! wakes the supervisor, and a watcher thread blocked in
//! `waitid(P_PID, WEXITED | WNOWAIT)` closes a pipe when the leader exits.
//! (`kqueue` `EVFILT_PROC` would need no thread, but rustix's `kevent` is
//! `unsafe` and this crate forbids `unsafe`.) A working directory is entered
//! with `fchdir` on the grant descriptor in the child, through the private
//! `bun-native-macos-services` crate.

use super::Failure;
use crate::services::files::{Directory, directory_beneath, failure as path_failure};
use bun_native_protocol::ErrorCode;
use rustix::fs::{OFlags, fcntl_getfl, fcntl_setfl};
use rustix::io::Errno;
use rustix::process::{Pid, WaitId, WaitIdOptions, waitid};
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::thread::JoinHandle;

pub(super) fn available() -> bool {
    true
}

pub(super) const UNAVAILABLE: &str = "owned processes are unavailable on this macOS host";

/// A close-on-exec pipe whose read end never blocks.
fn pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
    let (reader, writer) = std::io::pipe()?;
    let (reader, writer) = (OwnedFd::from(reader), OwnedFd::from(writer));
    for fd in [&reader, &writer] {
        fcntl_setfl(fd, fcntl_getfl(fd)? | OFlags::NONBLOCK)?;
    }
    Ok((reader, writer))
}

pub(super) struct Wake {
    reader: OwnedFd,
    writer: OwnedFd,
}

impl Wake {
    pub(super) fn new() -> std::io::Result<Self> {
        let (reader, writer) = pipe()?;
        Ok(Self { reader, writer })
    }

    /// A full pipe already holds a pending wake, so a failed write loses none.
    pub(super) fn notify(&self) {
        let _ = rustix::io::write(&self.writer, &[1]);
    }

    pub(super) fn drain(&self) {
        let mut buffer = [0; 64];
        while matches!(rustix::io::read(&self.reader, &mut buffer), Ok(length) if length > 0) {}
    }
}

impl AsFd for Wake {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.reader.as_fd()
    }
}

/// Readable (end of file) once the leader has exited. `WNOWAIT` leaves the
/// zombie in place, so its PID and group ID cannot be reused until the
/// supervisor joins this watcher and only then reaps the leader.
pub(super) struct ExitWatch {
    ready: OwnedFd,
    thread: Option<JoinHandle<()>>,
}

impl ExitWatch {
    pub(super) fn new(pid: Pid) -> Result<Self, Failure> {
        let failure = (ErrorCode::NativeFailure, "cannot observe the process");
        let (ready, writer) = pipe().map_err(|_| failure)?;
        let thread = std::thread::Builder::new()
            .name("bun-native-process-exit".into())
            .spawn(move || {
                while let Err(Errno::INTR) = waitid(
                    WaitId::Pid(pid),
                    WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
                ) {}
                drop(writer);
            })
            .map_err(|_| failure)?;
        Ok(Self {
            ready,
            thread: Some(thread),
        })
    }

    /// True once the watcher has seen the leader become a zombie.
    pub(super) fn exited(&self) -> bool {
        let mut byte = [0; 1];
        matches!(rustix::io::read(&self.ready, &mut byte), Ok(0))
    }

    /// Joins the watcher. Called only once the leader has exited or been
    /// killed, and always before the leader is reaped.
    pub(super) fn finish(&mut self) {
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl AsFd for ExitWatch {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.ready.as_fd()
    }
}

/// The opened directory the child starts in. macOS has no path that names an
/// open descriptor, so the string is unused: the child calls `fchdir` on the
/// descriptor itself (see [`enter`]), never on a path recovered from it.
pub(super) fn working_directory(
    directory: Option<&(Directory, String)>,
) -> Result<Option<(OwnedFd, String)>, Failure> {
    let Some((root, path)) = directory else {
        return Ok(None);
    };
    let fd = directory_beneath(root, path).map_err(|failure| match failure.0 {
        ErrorCode::NotFound | ErrorCode::WrongKind | ErrorCode::PathDenied => failure,
        _ => path_failure(Errno::ACCESS),
    })?;
    Ok(Some((fd, String::new())))
}

/// The child changes into the descriptor between fork and exec. The caller
/// keeps the descriptor open until the spawn returns.
pub(super) fn enter(command: &mut std::process::Command, directory: &OwnedFd, _cwd: &str) {
    bun_native_macos_services::start_in_directory(command, directory.as_fd());
}

/// The same for a pseudo-terminal command.
pub(super) fn enter_pty(
    command: pty_process::blocking::Command,
    directory: &OwnedFd,
    _cwd: &str,
) -> pty_process::blocking::Command {
    bun_native_macos_services::start_pty_in_directory(command, directory.as_fd())
}
