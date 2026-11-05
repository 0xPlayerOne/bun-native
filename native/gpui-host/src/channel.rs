//! Bounded I/O workers keep pipe reads and writes off the native UI thread.

use async_channel::{Receiver, Sender};
use bun_native_protocol::{Command, CommandReader, Event, EventSequence, write_event};
use gpui::App;
use std::cell::Cell;
use std::io;
use std::rc::Rc;
use std::sync::mpsc::{SyncSender, sync_channel};

pub(crate) enum Incoming {
    Command(Command),
    InvalidFrame,
    Disconnected,
}

enum Outgoing {
    Event(Event),
    Finish(Event, Sender<()>),
}

#[derive(Clone)]
pub(crate) struct EventSink {
    sender: SyncSender<Outgoing>,
    sequence: Rc<Cell<u64>>,
}

impl EventSink {
    pub(crate) fn ui(&self, event: impl FnOnce(EventSequence) -> Event, cx: &mut App) {
        let next = self.sequence.get() + 1;
        let Ok(sequence) = EventSequence::try_from(next) else {
            eprintln!("Bun Native UI event sequence exhausted");
            cx.quit();
            return;
        };
        self.sequence.set(next);
        self.send(event(sequence), cx);
    }

    pub(crate) fn send(&self, event: Event, cx: &mut App) {
        if self.sender.try_send(Outgoing::Event(event)).is_err() {
            eprintln!("Bun Native event channel disconnected or exceeded its 256-event capacity");
            cx.quit();
        }
    }

    /// The receiver resolves only after the final event has been flushed.
    pub(crate) fn finish(&self, event: Event) -> Option<Receiver<()>> {
        let (sender, receiver) = async_channel::bounded(1);
        self.sender.try_send(Outgoing::Finish(event, sender)).ok()?;
        Some(receiver)
    }
}

pub(crate) fn connect() -> (Receiver<Incoming>, EventSink) {
    let (commands, receiver) = async_channel::bounded(64);
    let (sender, events) = sync_channel(256);
    let failures = commands.clone();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        let mut reader = CommandReader::default();
        loop {
            let incoming = match reader.read(&mut input) {
                Ok(Some(command)) => Incoming::Command(command),
                Ok(None) => Incoming::Disconnected,
                Err(_) => Incoming::InvalidFrame,
            };
            let terminal = !matches!(incoming, Incoming::Command(_));
            if commands.send_blocking(incoming).is_err() || terminal {
                break;
            }
        }
    });
    std::thread::spawn(move || {
        let stdout = io::stdout();
        let mut output = stdout.lock();
        while let Ok(outgoing) = events.recv() {
            let (event, completion) = match outgoing {
                Outgoing::Event(event) => (event, None),
                Outgoing::Finish(event, completion) => (event, Some(completion)),
            };
            if write_event(&mut output, &event).is_err() {
                let _ = failures.try_send(Incoming::Disconnected);
                break;
            }
            if let Some(completion) = completion {
                let _ = completion.send_blocking(());
                break;
            }
        }
    });
    (
        receiver,
        EventSink {
            sender,
            sequence: Rc::new(Cell::new(0)),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use bun_native_protocol::RequestId;

    fn sink(capacity: usize) -> (EventSink, std::sync::mpsc::Receiver<Outgoing>) {
        let (sender, events) = sync_channel(capacity);
        let sink = EventSink {
            sender,
            sequence: Rc::new(Cell::new(0)),
        };
        (sink, events)
    }

    fn ack(id: u64) -> Event {
        Event::Ack {
            id: RequestId::try_from(id).unwrap(),
        }
    }

    #[test]
    fn finish_queues_its_event_with_a_completion_that_resolves_once() {
        let (sink, events) = sink(1);
        let flushed = sink.finish(ack(7)).expect("queue had capacity");
        let Ok(Outgoing::Finish(event, completion)) = events.try_recv() else {
            panic!("finish must queue a completion-carrying event");
        };
        assert_eq!(event, ack(7));
        assert!(flushed.try_recv().is_err());
        completion.send_blocking(()).unwrap();
        assert_eq!(flushed.try_recv(), Ok(()));
        // The completion channel holds exactly one acknowledgement.
        drop(completion);
        assert!(flushed.try_recv().is_err());
    }

    #[test]
    fn finish_fails_without_blocking_on_a_full_or_closed_writer() {
        let (sink, events) = sink(1);
        assert!(sink.finish(ack(1)).is_some());
        assert!(sink.finish(ack(2)).is_none());
        assert!(matches!(events.try_recv(), Ok(Outgoing::Finish(..))));
        drop(events);
        assert!(sink.finish(ack(3)).is_none());
    }

    #[test]
    fn clones_share_one_event_sequence_and_queue() {
        let (sink, events) = sink(2);
        let clone = sink.clone();
        clone.sequence.set(41);
        assert_eq!(sink.sequence.get(), 41);
        assert!(clone.finish(ack(1)).is_some());
        assert!(sink.finish(ack(2)).is_some());
        assert_eq!(events.try_iter().count(), 2);
    }
}
