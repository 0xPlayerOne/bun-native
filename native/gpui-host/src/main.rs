mod channel;
mod evidence;
mod input;
mod view;

use bun_native_protocol::{Command, ErrorCode, Event, PROTOCOL_VERSION};
use channel::{EventSink, Incoming};
use evidence::Evidence;
use gpui::{
    App, Bounds, Focusable, QuitMode, TitlebarOptions, WindowBounds, WindowHandle, WindowOptions,
    prelude::*, px, size,
};
use input::TextInput;
use std::cell::Cell;
use std::rc::Rc;
use view::NativeView;

struct Session {
    greeted: bool,
    window: Rc<Cell<Option<WindowHandle<NativeView>>>>,
    finishing: Rc<Cell<bool>>,
    events: EventSink,
    evidence: Evidence,
}

impl Session {
    fn error(&self, id: u64, code: ErrorCode, message: &str, cx: &mut App) {
        self.events.send(
            Event::Error {
                id: Some(id),
                code,
                message: message.into(),
            },
            cx,
        );
    }

    fn dispatch(&mut self, command: Command, cx: &mut App) {
        let id = command.id();
        if let Command::Hello { protocol, .. } = command {
            if self.greeted {
                self.error(
                    id,
                    ErrorCode::InvalidState,
                    "hello has already completed",
                    cx,
                );
            } else if protocol != PROTOCOL_VERSION {
                self.error(
                    id,
                    ErrorCode::VersionMismatch,
                    "unsupported protocol version",
                    cx,
                );
            } else {
                self.greeted = true;
                self.events.send(
                    Event::Ready {
                        protocol: PROTOCOL_VERSION,
                    },
                    cx,
                );
                self.events.send(Event::Ack { id }, cx);
            }
            return;
        }
        if !self.greeted {
            self.error(
                id,
                ErrorCode::InvalidState,
                "hello is required before native commands",
                cx,
            );
            return;
        }
        match command {
            Command::Open {
                title, text, input, ..
            } => {
                if self.window.get().is_some() {
                    self.error(id, ErrorCode::InvalidState, "a window is already open", cx);
                    return;
                }
                let events = self.events.clone();
                let evidence = self.evidence.clone();
                let bounds = Bounds::centered(None, size(px(560.), px(380.)), cx);
                let result = cx.open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        titlebar: Some(TitlebarOptions {
                            title: Some(title.into()),
                            ..Default::default()
                        }),
                        app_id: Some("dev.bunnative.fixture".into()),
                        ..Default::default()
                    },
                    move |window, cx| {
                        evidence.renderer(window.gpu_specs());
                        let input_events = events.clone();
                        let input = cx.new(|cx| TextInput::new(input, input_events, cx));
                        window.focus(&input.focus_handle(cx), cx);
                        cx.new(|_| NativeView::new(text, input, events, evidence))
                    },
                );
                match result {
                    Ok(window) => {
                        self.window.set(Some(window));
                        cx.activate(true);
                        self.events.send(Event::Opened { id }, cx);
                    }
                    Err(error) => {
                        eprintln!("Bun Native window creation failed: {error:#}");
                        self.error(
                            id,
                            ErrorCode::NativeFailure,
                            "native window creation failed; see stderr",
                            cx,
                        );
                    }
                }
            }
            Command::Update { text, input, .. } => {
                let Some(window) = self.window.get() else {
                    self.error(id, ErrorCode::InvalidState, "no window is open", cx);
                    return;
                };
                let result = window.update(cx, |view, window, cx| {
                    if let Some(text) = text {
                        view.text = text;
                    }
                    if let Some(input) = input {
                        view.input
                            .update(cx, |view, cx| view.set_content(input, window, cx));
                    }
                    cx.notify();
                });
                if result.is_ok() {
                    self.events.send(Event::Ack { id }, cx);
                } else {
                    self.error(
                        id,
                        ErrorCode::NativeFailure,
                        "native window update failed",
                        cx,
                    );
                }
            }
            Command::Close { .. } => {
                let Some(window) = self.window.get() else {
                    self.error(id, ErrorCode::InvalidState, "no window is open", cx);
                    return;
                };
                if window
                    .update(cx, |_, window, _| window.remove_window())
                    .is_ok()
                {
                    self.events.send(Event::Ack { id }, cx);
                } else {
                    self.error(
                        id,
                        ErrorCode::NativeFailure,
                        "native window close failed",
                        cx,
                    );
                }
            }
            Command::Shutdown { .. } => self.finish(Event::Ack { id }, cx),
            Command::Hello { .. } => unreachable!("hello handled before command dispatch"),
        }
    }

    fn finish(&self, final_event: Event, cx: &mut App) {
        self.finishing.set(true);
        match self.events.finish(final_event) {
            Some(flushed) => cx
                .spawn(async move |cx| {
                    let _ = flushed.recv().await;
                    cx.update(|cx| cx.quit());
                })
                .detach(),
            None => cx.quit(),
        }
    }
}

fn main() {
    let (commands, events) = channel::connect();
    let evidence = Evidence::from_environment();
    gpui_platform::application()
        .with_quit_mode(QuitMode::Explicit)
        .run(move |cx: &mut App| {
            input::bind_keys(cx);
            let window = Rc::new(Cell::new(None::<WindowHandle<NativeView>>));
            let finishing = Rc::new(Cell::new(false));
            cx.on_window_closed({
                let window = window.clone();
                let events = events.clone();
                let finishing = finishing.clone();
                move |cx, _| {
                    if window.take().is_some() && !finishing.get() {
                        events.send(Event::Closed, cx);
                    }
                }
            })
            .detach();
            let mut session = Session {
                greeted: false,
                window,
                finishing,
                events,
                evidence,
            };
            cx.spawn(async move |cx| {
                while let Ok(incoming) = commands.recv().await {
                    cx.update(|cx| match incoming {
                        Incoming::Command(command) => session.dispatch(command, cx),
                        Incoming::InvalidFrame => session.finish(
                            Event::Error {
                                id: None,
                                code: ErrorCode::InvalidCommand,
                                message: "invalid, oversized or truncated command frame".into(),
                            },
                            cx,
                        ),
                        Incoming::Disconnected => {
                            session.finishing.set(true);
                            cx.quit();
                        }
                    });
                    if session.finishing.get() {
                        break;
                    }
                }
            })
            .detach();
        });
}
