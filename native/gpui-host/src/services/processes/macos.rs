//! macOS: no pidfd, eventfd or descriptor-relative working directory. A pipe
//! wakes the supervisor, and a watcher thread blocked in
//! `waitid(P_PID, WEXITED | WNOWAIT)` closes a pipe when the leader exits.
//! (`kqueue` `EVFILT_PROC` would need no thread, but rustix's `kevent` is
//! `unsafe` and this crate forbids `unsafe`.)

use super::Failure;
use crate::services::files::Directory;
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

/// macOS has no `/proc/self/fd` and std offers no safe `fchdir` in the child,
/// so the child cannot start in a grant directory descriptor. Starting in a
/// path recovered with `F_GETPATH` would reintroduce the check-then-use race
/// that grant descriptors exist to remove, so a working directory is refused.
pub(super) fn working_directory(
    directory: Option<&(Directory, String)>,
) -> Result<Option<(OwnedFd, String)>, Failure> {
    match directory {
        None => Ok(None),
        Some(_) => Err((
            ErrorCode::ServiceUnavailable,
            "a process working directory is unavailable on this macOS host",
        )),
    }
}
