//! Event-driven idle wait for queued jobs, shutdown, or an owned X selection.

use rustix::event::{PollFd, PollFlags, poll};
use std::io::{self, Read, Write};
use std::os::fd::{AsFd, BorrowedFd};
use std::os::unix::net::UnixStream;

pub(super) struct Sender(UnixStream);
pub(super) struct Receiver(UnixStream);

pub(super) fn pair() -> io::Result<(Sender, Receiver)> {
    let (sender, receiver) = UnixStream::pair()?;
    sender.set_nonblocking(true)?;
    receiver.set_nonblocking(true)?;
    Ok((Sender(sender), Receiver(receiver)))
}

impl Sender {
    pub(super) fn notify(&self) -> io::Result<()> {
        loop {
            match (&self.0).write(&[1]) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                // WouldBlock means an unread notification already wakes the
                // receiver. Other failures must revoke and join the worker.
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                Err(error) => return Err(error),
                Ok(1) => return Ok(()),
                Ok(_) => return Err(io::ErrorKind::WriteZero.into()),
            }
        }
    }
}

impl Receiver {
    pub(super) fn wait(&self, selection: Option<BorrowedFd<'_>>) -> io::Result<bool> {
        let mut sources = [
            PollFd::new(&self.0, PollFlags::IN),
            PollFd::from_borrowed_fd(selection.unwrap_or(self.0.as_fd()), PollFlags::IN),
        ];
        loop {
            match poll(
                &mut sources[..if selection.is_some() { 2 } else { 1 }],
                None,
            ) {
                Ok(_) => break,
                Err(rustix::io::Errno::INTR) => {}
                Err(error) => return Err(error.into()),
            }
        }
        let mut bytes = [0; 128];
        loop {
            match (&self.0).read(&mut bytes) {
                Ok(0) => return Ok(false),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(true),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn notifications_coalesce_without_periodic_idle_wakeups() {
        let (sender, receiver) = pair().unwrap();
        for _ in 0..1024 {
            sender.notify().unwrap();
        }
        let (first, first_result) = mpsc::channel();
        let (completed, result) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            first.send(receiver.wait(None).unwrap()).unwrap();
            completed.send(receiver.wait(None).unwrap()).unwrap();
        });
        assert!(first_result.recv_timeout(Duration::from_secs(1)).unwrap());
        assert!(matches!(
            result.recv_timeout(Duration::from_millis(30)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        sender.notify().unwrap();
        assert!(result.recv_timeout(Duration::from_secs(1)).unwrap());
        thread.join().unwrap();
    }

    #[test]
    fn dropping_the_sender_wakes_shutdown_without_a_polling_timer() {
        let (sender, receiver) = pair().unwrap();
        let (completed, result) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            completed.send(receiver.wait(None).unwrap()).unwrap();
        });
        drop(sender);
        assert!(!result.recv_timeout(Duration::from_secs(1)).unwrap());
        thread.join().unwrap();
    }

    #[test]
    fn a_closed_receiver_is_an_error_instead_of_a_lost_notification() {
        let (sender, receiver) = pair().unwrap();
        drop(receiver);
        assert!(sender.notify().is_err());
    }

    #[test]
    fn owned_selection_input_wakes_an_otherwise_idle_worker() {
        let (_sender, receiver) = pair().unwrap();
        let (selection, mut requestor) = UnixStream::pair().unwrap();
        let (completed, result) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            completed
                .send(receiver.wait(Some(selection.as_fd())).unwrap())
                .unwrap();
        });
        requestor.write_all(&[1]).unwrap();
        assert!(result.recv_timeout(Duration::from_secs(1)).unwrap());
        thread.join().unwrap();
    }
}
