//! x11rb remains the protocol implementation. This stream supplies the missing
//! total deadline/cancellation bound for its otherwise blocking reply waits.

use super::{Budget, Failure, WORKER_POLL};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fd::AsFd;
use rustix::net::{AddressFamily, SocketAddrUnix, SocketFlags, SocketType, connect, socket_with};
use std::cell::RefCell;
use std::io::{self, IoSlice};
use std::os::unix::net::UnixStream;
use std::time::Instant;
use x11rb::reexports::x11rb_protocol::xauth::Family;
use x11rb::rust_connection::{DefaultStream, PollMode, Stream};
use x11rb::utils::RawFdContainer;

pub(super) struct BoundedStream {
    inner: DefaultStream,
    budget: RefCell<Budget>,
}

impl BoundedStream {
    pub(super) fn local(path: &str, budget: &Budget) -> Result<(Self, (Family, Vec<u8>)), Failure> {
        budget.check()?;
        let abstract_address =
            SocketAddrUnix::new_abstract_name(path.as_bytes()).map_err(|_| budget.failure())?;
        let address = SocketAddrUnix::new(path).map_err(|_| budget.failure())?;
        let connect_to = |address: &SocketAddrUnix| -> io::Result<UnixStream> {
            let socket = socket_with(
                AddressFamily::UNIX,
                SocketType::STREAM,
                SocketFlags::NONBLOCK | SocketFlags::CLOEXEC,
                None,
            )?;
            match connect(&socket, address) {
                Ok(()) => {}
                Err(rustix::io::Errno::INPROGRESS) => loop {
                    wait(&socket, PollFlags::OUT, budget)?;
                    match rustix::net::sockopt::socket_error(&socket)? {
                        Ok(()) => break,
                        Err(rustix::io::Errno::INPROGRESS) => continue,
                        Err(error) => return Err(error.into()),
                    }
                },
                Err(error) => return Err(error.into()),
            }
            Ok(UnixStream::from(socket))
        };
        let unix = connect_to(&abstract_address)
            .or_else(|_| connect_to(&address))
            .map_err(|_| budget.failure())?;
        let (inner, peer) = DefaultStream::from_unix_stream(unix).map_err(|_| budget.failure())?;
        Ok((
            Self {
                inner,
                budget: RefCell::new(budget.clone()),
            },
            peer,
        ))
    }

    pub(super) fn set_budget(&self, budget: &Budget) {
        self.budget.replace(budget.clone());
    }

    fn checked(&self) -> io::Result<()> {
        check(&self.budget.borrow())
    }
}

fn check(budget: &Budget) -> io::Result<()> {
    budget.check().map_err(|(code, message)| {
        let kind = if code == bun_native_protocol::ErrorCode::OperationTimedOut {
            io::ErrorKind::TimedOut
        } else {
            io::ErrorKind::ConnectionAborted
        };
        io::Error::new(kind, message)
    })
}

fn wait(fd: &impl AsFd, flags: PollFlags, budget: &Budget) -> io::Result<()> {
    loop {
        check(budget)?;
        let duration = budget
            .deadline
            .saturating_duration_since(Instant::now())
            .min(WORKER_POLL);
        let timeout = Timespec {
            tv_sec: 0,
            tv_nsec: duration.as_nanos() as i64,
        };
        match poll(&mut [PollFd::new(fd, flags)], Some(&timeout)) {
            Ok(_) => return check(budget),
            Err(rustix::io::Errno::INTR) => {}
            Err(error) => return Err(error.into()),
        }
    }
}

impl Stream for BoundedStream {
    fn poll(&self, mode: PollMode) -> io::Result<()> {
        let mut flags = PollFlags::empty();
        if mode.readable() {
            flags |= PollFlags::IN;
        }
        if mode.writable() {
            flags |= PollFlags::OUT;
        }
        wait(&self.inner, flags, &self.budget.borrow())
    }

    fn read(&self, buffer: &mut [u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.checked()?;
        self.inner.read(buffer, fds)
    }

    fn write(&self, buffer: &[u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.checked()?;
        self.inner.write(buffer, fds)
    }

    fn write_vectored(
        &self,
        buffers: &[IoSlice<'_>],
        fds: &mut Vec<RawFdContainer>,
    ) -> io::Result<usize> {
        self.checked()?;
        self.inner.write_vectored(buffers, fds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[test]
    fn socket_wait_obeys_total_deadline_and_owner_cancellation() {
        let (left, _right) = UnixStream::pair().unwrap();
        let budget = Budget {
            deadline: Instant::now() + Duration::from_millis(30),
            cancelled: Arc::new(AtomicBool::new(false)),
            stopping: Arc::new(AtomicBool::new(false)),
        };
        let (inner, _) = DefaultStream::from_unix_stream(left).unwrap();
        let stream = BoundedStream {
            inner,
            budget: RefCell::new(budget.clone()),
        };
        while stream.poll(PollMode::Readable).is_ok() {}
        assert_eq!(
            stream.poll(PollMode::Readable).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        let fresh = Budget {
            deadline: Instant::now() + Duration::from_secs(2),
            ..budget
        };
        stream.set_budget(&fresh);
        fresh.cancelled.store(true, Ordering::Release);
        assert_eq!(
            stream.poll(PollMode::Readable).unwrap_err().kind(),
            io::ErrorKind::ConnectionAborted
        );
    }
}
