mod channel;
mod evidence;
mod input;
mod services;
mod session;
mod state;
mod style;
mod view;

use bun_native_protocol::{ErrorCode, Event};
use channel::Incoming;
use gpui::{App, QuitMode};
use session::Session;
use std::time::Duration;

const COMMANDS_PER_TURN: usize = 16;
const COMMAND_TIME_BUDGET: Duration = Duration::from_millis(4);
const COMMAND_YIELD_DELAY: Duration = Duration::from_millis(1);

fn main() {
    let policy = match services::policy(std::env::args_os().skip(1)) {
        Ok(policy) => policy,
        Err(message) => {
            eprintln!("Bun Native: {message}");
            std::process::exit(2);
        }
    };
    let (commands, events) = channel::connect();
    let evidence = evidence::Evidence::from_environment();
    gpui_platform::application()
        .with_quit_mode(QuitMode::Explicit)
        .run(move |cx: &mut App| {
            input::bind_keys(cx);
            view::bind_keys(cx);
            let mut session = Session::new(events, evidence, policy, cx);
            cx.spawn(async move |cx| {
                let executor = cx.background_executor().clone();
                let mut turn_started = executor.now();
                let mut commands_in_turn = 0;
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
                        Incoming::Disconnected => session.disconnect(cx),
                    });
                    if session.finishing() {
                        break;
                    }
                    commands_in_turn += 1;
                    if commands_in_turn >= COMMANDS_PER_TURN
                        || executor.now() - turn_started >= COMMAND_TIME_BUDGET
                    {
                        // A ready receiver does not suspend this foreground
                        // future. Give native input and paint a turn between
                        // complete atomic commands, even under a full queue.
                        // GPUI's zero-duration timer is ready immediately.
                        executor.timer(COMMAND_YIELD_DELAY).await;
                        turn_started = executor.now();
                        commands_in_turn = 0;
                    }
                }
            })
            .detach();
        });
}
