//! Private Windows boundary for the native host's filesystem grants and owned
//! processes. The host crate forbids `unsafe`, so every Win32 and NT call it
//! needs is wrapped here behind a small safe API: descriptor-style relative
//! opens that never follow a reparse point (`fs`), and job objects, pipes,
//! pseudo-consoles and `CreateProcessW` (`process`). The name and command-line
//! rules are plain Rust, compiled and tested on every platform.

pub mod command_line;
#[cfg(windows)]
pub mod fs;
pub mod names;
#[cfg(windows)]
pub mod process;
#[cfg(windows)]
pub mod task_dialog;
pub mod task_dialog_spec;
#[cfg(windows)]
mod wide;
