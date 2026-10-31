//! Bounded I/O workers keep pipe reads and writes off the native UI thread.

use async_channel::{Receiver, Sender};
use bun_native_protocol::{Command, CommandReader, Event, write_event};
use gpui::App;
use std::io;
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
}

impl EventSink {
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
    (receiver, EventSink { sender })
}
