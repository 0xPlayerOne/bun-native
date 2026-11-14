//! Identify a receive that actually yielded to the foreground executor.

use async_channel::{Receiver, RecvError};
use std::future::{Future, poll_fn};
use std::pin::pin;

/// Returns whether the receive was ever pending, so a command turn does not
/// count idle time as continuous foreground work. A ready receive is not a
/// yield, including an enqueue racing the first poll.
pub(crate) async fn receive<T>(receiver: &Receiver<T>) -> (Result<T, RecvError>, bool) {
    let mut receive = pin!(receiver.recv());
    let mut suspended = false;
    let result = poll_fn(|cx| {
        let result = receive.as_mut().poll(cx);
        suspended |= result.is_pending();
        result
    })
    .await;
    (result, suspended)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::{Context, Poll, Waker};

    #[test]
    fn already_queued_commands_do_not_reset_the_turn() {
        let (sender, receiver) = async_channel::bounded(1);
        sender.try_send(7).unwrap();
        let mut task = pin!(receive(&receiver));
        let mut context = Context::from_waker(Waker::noop());
        assert_eq!(
            task.as_mut().poll(&mut context),
            Poll::Ready((Ok(7), false))
        );
    }

    #[test]
    fn pending_receive_starts_a_new_turn_after_wake() {
        let (sender, receiver) = async_channel::bounded(1);
        let mut task = pin!(receive(&receiver));
        let mut context = Context::from_waker(Waker::noop());
        assert!(task.as_mut().poll(&mut context).is_pending());
        sender.try_send(7).unwrap();
        assert_eq!(task.as_mut().poll(&mut context), Poll::Ready((Ok(7), true)));
    }

    #[test]
    fn closed_channel_still_ends_the_loop() {
        let (sender, receiver) = async_channel::bounded::<u8>(1);
        drop(sender);
        let mut task = pin!(receive(&receiver));
        let mut context = Context::from_waker(Waker::noop());
        assert_eq!(
            task.as_mut().poll(&mut context),
            Poll::Ready((Err(RecvError), false))
        );
    }
}
