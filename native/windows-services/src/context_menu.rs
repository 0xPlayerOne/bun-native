//! Win32 popup menus for OS context menus. `TrackPopupMenuEx` runs a modal
//! menu loop on the calling thread, which must own the owner window, and
//! returns the chosen command. The loop dispatches the thread's other window
//! messages, so the caller's posted work, including [`end`], keeps running.
#![allow(unsafe_code, reason = "the reviewed popup menu calls of this boundary")]

use crate::context_menu_spec::MenuNode;
use crate::wide::terminated;
use std::ffi::OsStr;
use std::io;
use windows_sys::Win32::Foundation::{HWND, POINT};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, DestroyMenu, EndMenu, HMENU, MF_CHECKED, MF_GRAYED, MF_POPUP,
    MF_SEPARATOR, MF_STRING, PostMessageW, SetForegroundWindow, TPM_LEFTALIGN, TPM_RETURNCMD,
    TPM_RIGHTBUTTON, TPM_TOPALIGN, TrackPopupMenuEx, WM_NULL,
};

/// Destroys the top-level menu, and with it every attached submenu.
struct Menu(HMENU);

impl Drop for Menu {
    fn drop(&mut self) {
        // SAFETY: a menu this module created and has not destroyed.
        unsafe { DestroyMenu(self.0) };
    }
}

fn append(menu: HMENU, nodes: &[MenuNode]) -> io::Result<()> {
    for node in nodes {
        // SAFETY: `menu` is a live popup menu; every string is NUL-terminated
        // and copied by `AppendMenuW` before it returns.
        let appended = match node {
            MenuNode::Item {
                command,
                text,
                enabled,
                checked,
            } => {
                let text = terminated(OsStr::new(text))?;
                let flags = MF_STRING
                    | if *enabled { 0 } else { MF_GRAYED }
                    | if *checked { MF_CHECKED } else { 0 };
                unsafe { AppendMenuW(menu, flags, *command as usize, text.as_ptr()) }
            }
            MenuNode::Separator => unsafe { AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null()) },
            MenuNode::Submenu {
                text,
                enabled,
                items,
            } => {
                let text = terminated(OsStr::new(text))?;
                // SAFETY: creates an empty popup menu or returns null.
                let submenu = unsafe { CreatePopupMenu() };
                if submenu.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let submenu = Menu(submenu);
                append(submenu.0, items)?;
                let flags = MF_POPUP | MF_STRING | if *enabled { 0 } else { MF_GRAYED };
                let appended =
                    unsafe { AppendMenuW(menu, flags, submenu.0 as usize, text.as_ptr()) };
                if appended != 0 {
                    // The parent owns and destroys it now.
                    std::mem::forget(submenu);
                }
                appended
            }
        };
        if appended == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Show the menu at `(x, y)` physical pixels of `owner`'s client area (an
/// `HWND`) and wait for it to close. Returns the chosen command, or `None`
/// when the menu was dismissed or ended with [`end`].
pub fn show(owner: isize, x: i32, y: i32, nodes: &[MenuNode]) -> io::Result<Option<u32>> {
    let window = owner as HWND;
    // SAFETY: creates an empty popup menu or returns null.
    let menu = unsafe { CreatePopupMenu() };
    if menu.is_null() {
        return Err(io::Error::last_os_error());
    }
    let menu = Menu(menu);
    append(menu.0, nodes)?;
    let mut point = POINT { x, y };
    // SAFETY: `point` is a valid out pointer; an invalid window just fails.
    if unsafe { ClientToScreen(window, &mut point) } == 0 {
        return Err(io::Error::other("the owner window has no client area"));
    }
    // The documented pattern: the owner must be foreground, or the menu does
    // not close when the user clicks elsewhere; WM_NULL lets the second
    // invocation behave.
    // SAFETY: plain window-handle calls; an invalid handle just fails.
    let chosen = unsafe {
        SetForegroundWindow(window);
        let chosen = TrackPopupMenuEx(
            menu.0,
            TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_LEFTALIGN | TPM_TOPALIGN,
            point.x,
            point.y,
            window,
            std::ptr::null(),
        );
        PostMessageW(window, WM_NULL, 0, 0);
        chosen
    };
    Ok(u32::try_from(chosen).ok().filter(|command| *command > 0))
}

/// End the menu this thread is tracking, if any.
pub fn end() {
    // SAFETY: no arguments; ends the calling thread's active menu, if any.
    unsafe { EndMenu() };
}
