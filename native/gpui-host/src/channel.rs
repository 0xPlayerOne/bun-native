//! Bounded I/O workers keep pipe reads and writes off the native UI thread.

use async_channel::{Receiver, Sender};
use bun_native_protocol::{CommandReader, Event, EventSequence, EventWriter, ValidCommand};
use gpui::App;
use std::cell::Cell;
use std::io;
use std::rc::Rc;
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::time::{Duration, Instant};

/// Events the UI thread may queue ahead of the stdout writer.
const EVENT_CAPACITY: usize = 256;
/// A full queue applies backpressure: the UI thread waits for Bun to read, so
/// a burst during a long JavaScript task or GC pause loses and reorders
/// nothing, and memory stays bounded. The wait is bounded too (ADR 0003): a
/// consumer that reads nothing for this long ends the session, as Bun's own
/// requests time out after the same default.
const SEND_DEADLINE: Duration = Duration::from_secs(5);
/// How long shutdown waits for room for its final event.
const FINISH_DEADLINE: Duration = Duration::from_secs(2);

/// Why an event could not be queued.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Undelivered {
    /// The writer is gone: stdout closed or failed, so Bun cannot read.
    Closed,
    /// The queue stayed full past the deadline.
    TimedOut,
}

pub(crate) enum Incoming {
    Command(ValidCommand),
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

    /// Queues an event, waiting up to [`SEND_DEADLINE`] while the queue is
    /// full. Only a closed writer or a consumer stalled past the deadline ends
    /// the session.
    pub(crate) fn send(&self, event: Event, cx: &mut App) {
        match self.queue(event, SEND_DEADLINE) {
            Ok(stalled) if stalled >= Duration::from_millis(100) => eprintln!(
                "Bun Native waited {} ms for Bun to read events",
                stalled.as_millis()
            ),
            Ok(_) => {}
            Err(Undelivered::Closed) => {
                eprintln!("Bun Native event channel disconnected");
                cx.quit();
            }
            Err(Undelivered::TimedOut) => {
                eprintln!(
                    "Bun Native stopped: Bun read no events for {} s with {EVENT_CAPACITY} queued",
                    SEND_DEADLINE.as_secs()
                );
                cx.quit();
            }
        }
    }

    /// Returns how long the queue was full.
    fn queue(&self, event: Event, limit: Duration) -> Result<Duration, Undelivered> {
        let started = Instant::now();
        offer(&self.sender, Outgoing::Event(event), started + limit)?;
        Ok(started.elapsed())
    }

    /// The receiver resolves only after the final event has been flushed.
    /// Waits up to [`FINISH_DEADLINE`] for room, so a full queue still
    /// delivers the final event instead of losing it.
    pub(crate) fn finish(&self, event: Event) -> Result<Receiver<()>, Undelivered> {
        self.finish_within(event, FINISH_DEADLINE)
    }

    fn finish_within(&self, event: Event, limit: Duration) -> Result<Receiver<()>, Undelivered> {
        let (sender, receiver) = async_channel::bounded(1);
        offer(
            &self.sender,
            Outgoing::Finish(event, sender),
            Instant::now() + limit,
        )?;
        Ok(receiver)
    }
}

/// Queues `item`, polling with a short backoff while the queue is full.
fn offer(
    sender: &SyncSender<Outgoing>,
    mut item: Outgoing,
    deadline: Instant,
) -> Result<(), Undelivered> {
    let mut pause = Duration::from_micros(20);
    loop {
        match sender.try_send(item) {
            Ok(()) => return Ok(()),
            Err(TrySendError::Disconnected(_)) => return Err(Undelivered::Closed),
            Err(TrySendError::Full(back)) => item = back,
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(Undelivered::TimedOut);
        }
        std::thread::sleep(pause.min(deadline - now));
        pause = (pause * 2).min(Duration::from_millis(1));
    }
}

pub(crate) fn connect() -> (Receiver<Incoming>, EventSink) {
    let (commands, receiver) = async_channel::bounded(64);
    let (sender, events) = sync_channel(EVENT_CAPACITY);
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
        let mut writer = EventWriter::default();
        while let Ok(outgoing) = events.recv() {
            let (event, completion) = match outgoing {
                Outgoing::Event(event) => (event, None),
                Outgoing::Finish(event, completion) => (event, Some(completion)),
            };
            if writer.write(&mut output, &event).is_err() {
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
    fn finish_gives_up_on_a_queue_that_stays_full_or_a_closed_writer() {
        let (sink, events) = sink(1);
        assert!(sink.finish(ack(1)).is_ok());
        let started = Instant::now();
        assert_eq!(
            sink.finish_within(ack(2), Duration::from_millis(30)).err(),
            Some(Undelivered::TimedOut)
        );
        assert!(started.elapsed() >= Duration::from_millis(30));
        assert!(matches!(events.try_recv(), Ok(Outgoing::Finish(..))));
        drop(events);
        assert_eq!(sink.finish(ack(3)).err(), Some(Undelivered::Closed));
    }

    #[test]
    fn finish_waits_for_room_instead_of_dropping_the_final_ack() {
        let (sink, events) = sink(1);
        assert!(sink.queue(ack(1), SEND_DEADLINE).is_ok());
        let reader = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            let first = events.recv().unwrap();
            let last = events.recv().unwrap();
            (first, last)
        });
        let flushed = sink.finish(ack(2));
        assert!(flushed.is_ok(), "the final ack waits for the reader");
        let (first, last) = reader.join().unwrap();
        assert!(matches!(first, Outgoing::Event(event) if event == ack(1)));
        assert!(matches!(last, Outgoing::Finish(event, _) if event == ack(2)));
    }

    #[test]
    fn a_full_queue_applies_backpressure_without_loss_or_reordering() {
        const BURST: u64 = 2_000;
        let (sink, events) = sink(EVENT_CAPACITY);
        // A slow reader: Bun busy for a moment, then draining.
        let reader = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            let mut seen = Vec::new();
            while let Ok(Outgoing::Event(Event::Ack { id })) = events.recv() {
                seen.push(id.get());
                if seen.len() as u64 == BURST {
                    break;
                }
            }
            seen
        });
        let mut stalled = Duration::ZERO;
        for id in 1..=BURST {
            stalled += sink.queue(ack(id), SEND_DEADLINE).unwrap();
        }
        let seen = reader.join().unwrap();
        assert_eq!(seen, (1..=BURST).collect::<Vec<_>>());
        assert!(
            stalled >= Duration::from_millis(40),
            "the sender waited for the reader"
        );
    }

    #[test]
    fn a_closed_writer_is_reported_even_when_the_queue_was_full() {
        let (sink, events) = sink(1);
        assert!(sink.queue(ack(1), SEND_DEADLINE).is_ok());
        let reader = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            drop(events);
        });
        assert_eq!(sink.queue(ack(2), SEND_DEADLINE), Err(Undelivered::Closed));
        reader.join().unwrap();
    }

    #[test]
    fn a_consumer_that_never_reads_ends_the_wait_at_the_deadline() {
        let (sink, _events) = sink(1);
        assert!(sink.queue(ack(1), SEND_DEADLINE).is_ok());
        let started = Instant::now();
        assert_eq!(
            sink.queue(ack(2), Duration::from_millis(30)),
            Err(Undelivered::TimedOut)
        );
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(30) && waited < Duration::from_secs(1));
    }

    #[test]
    fn clones_share_one_event_sequence_and_queue() {
        let (sink, events) = sink(2);
        let clone = sink.clone();
        clone.sequence.set(41);
        assert_eq!(sink.sequence.get(), 41);
        assert!(clone.finish(ack(1)).is_ok());
        assert!(sink.finish(ack(2)).is_ok());
        assert_eq!(events.try_iter().count(), 2);
    }
}
