//! Passive key grabs on the root window of the local X server.
//!
//! A grab names one keycode and one exact modifier mask, so each registration
//! grabs its mask combined with every Caps Lock / Num Lock state. Another X
//! client already holding any of those grabs is an explicit conflict
//! (`BadAccess`); no partial grab is retained.

use crate::services::x11::{Budget, Display, Failure, XConnection};
use bun_native_protocol::{ErrorCode, ShortcutId, ShortcutModifiers};
use std::collections::BTreeMap;
use std::os::fd::{AsFd, BorrowedFd};
use x11rb::connection::Connection;
use x11rb::errors::ReplyError;
use x11rb::protocol::xproto::{ConnectionExt, GrabMode, Keycode, Keysym, ModMask, Window};
use x11rb::protocol::{ErrorKind, Event};

const EVENT_BUDGET: usize = 64;
const KEYSYM_NUM_LOCK: Keysym = 0xff7f;
const KEYSYMS_ALT: [Keysym; 2] = [0xffe9, 0xffea];
const KEYSYMS_SUPER: [Keysym; 2] = [0xffeb, 0xffec];

/// A key in the protocol's closed set, as its unshifted X keysym.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Key(Keysym);

impl Key {
    pub(super) fn parse(name: &str) -> Option<Self> {
        match name.as_bytes() {
            // Latin-1 keysyms equal their lowercase letter and digit codes.
            [character @ (b'a'..=b'z' | b'0'..=b'9')] => Some(Self(Keysym::from(*character))),
            [b'f', rest @ ..] if !rest.is_empty() && rest[0] != b'0' => {
                let number: u32 = std::str::from_utf8(rest).ok()?.parse().ok()?;
                // XK_F1 is 0xffbe; F1-F12 are contiguous.
                (1..=12)
                    .contains(&number)
                    .then_some(Self(0xffbe + number - 1))
            }
            _ => None,
        }
    }
}

struct Grab {
    keycode: Keycode,
    mask: u16,
}

pub(super) struct Grabs {
    connection: XConnection,
    root: Window,
    keymap: Vec<(Keycode, Keysym)>,
    alt: Option<u16>,
    platform: Option<u16>,
    locks: Vec<u16>,
    active: BTreeMap<ShortcutId, Grab>,
    released: Option<(Keycode, u32)>,
}

fn modifier_mask(index: usize) -> u16 {
    1 << index
}

impl Grabs {
    pub(super) fn connect(display: &Display, budget: &Budget) -> Result<Self, Failure> {
        let connection = display.connect(budget)?;
        let setup = connection.setup();
        let root = setup.roots[display.screen].root;
        let (minimum, maximum) = (setup.min_keycode, setup.max_keycode);
        let mapping = connection
            .get_keyboard_mapping(minimum, maximum - minimum + 1)
            .map_err(|_| budget.failure())?
            .reply()
            .map_err(|_| budget.failure())?;
        let width = usize::from(mapping.keysyms_per_keycode);
        let mut keymap = Vec::new();
        if width > 0 {
            for (offset, row) in mapping.keysyms.chunks(width).enumerate() {
                let keycode = minimum.saturating_add(offset as u8);
                // Column zero is the unshifted level for this keycode.
                if let Some(keysym) = row.first().copied().filter(|keysym| *keysym != 0) {
                    keymap.push((keycode, keysym));
                }
            }
        }
        let modifiers = connection
            .get_modifier_mapping()
            .map_err(|_| budget.failure())?
            .reply()
            .map_err(|_| budget.failure())?;
        let per_modifier = usize::from(modifiers.keycodes_per_modifier());
        let mask_for = |keysyms: &[Keysym]| -> Option<u16> {
            if per_modifier == 0 {
                return None;
            }
            modifiers
                .keycodes
                .chunks(per_modifier)
                .enumerate()
                // Shift, Lock and Control (0-2) are fixed; Alt, Num Lock and
                // Super live on one of Mod1-Mod5 by server configuration.
                .skip(3)
                .find(|(_, keycodes)| {
                    keycodes.iter().any(|keycode| {
                        *keycode != 0
                            && keymap
                                .iter()
                                .any(|(code, keysym)| code == keycode && keysyms.contains(keysym))
                    })
                })
                .map(|(index, _)| modifier_mask(index))
        };
        let alt = mask_for(&KEYSYMS_ALT);
        let platform = mask_for(&KEYSYMS_SUPER);
        let num_lock = mask_for(&[KEYSYM_NUM_LOCK]).unwrap_or(0);
        let caps_lock = u16::from(ModMask::LOCK);
        let mut locks = vec![0, caps_lock, num_lock, caps_lock | num_lock];
        locks.sort_unstable();
        locks.dedup();
        Ok(Self {
            connection,
            root,
            keymap,
            alt,
            platform,
            locks,
            active: BTreeMap::new(),
            released: None,
        })
    }

    pub(super) fn fd(&self) -> BorrowedFd<'_> {
        self.connection.stream().as_fd()
    }

    fn mask(&self, modifiers: ShortcutModifiers) -> Result<u16, Failure> {
        let unmapped = (
            ErrorCode::ServiceUnavailable,
            "the requested modifier is not mapped by this X server",
        );
        let mut mask = 0;
        if modifiers.shift {
            mask |= u16::from(ModMask::SHIFT);
        }
        if modifiers.control {
            mask |= u16::from(ModMask::CONTROL);
        }
        if modifiers.alt {
            mask |= self.alt.ok_or(unmapped)?;
        }
        if modifiers.platform {
            mask |= self.platform.ok_or(unmapped)?;
        }
        if self.locks.iter().any(|lock| lock & mask != 0) {
            return Err(unmapped);
        }
        Ok(mask)
    }

    fn relevant(&self) -> u16 {
        u16::from(ModMask::SHIFT)
            | u16::from(ModMask::CONTROL)
            | self.alt.unwrap_or(0)
            | self.platform.unwrap_or(0)
    }

    pub(super) fn grab(
        &mut self,
        shortcut: ShortcutId,
        key: Key,
        modifiers: ShortcutModifiers,
        budget: &Budget,
    ) -> Result<(), Failure> {
        self.connection.stream().set_budget(budget);
        let keycode = self
            .keymap
            .iter()
            .find_map(|(keycode, keysym)| (*keysym == key.0).then_some(*keycode))
            .ok_or((
                ErrorCode::ServiceUnavailable,
                "the requested key is not on this X server's keyboard map",
            ))?;
        let mask = self.mask(modifiers)?;
        let mut cookies = Vec::with_capacity(self.locks.len());
        for lock in self.locks.iter().copied() {
            cookies.push(
                self.connection
                    .grab_key(
                        false,
                        self.root,
                        ModMask::from(mask | lock),
                        keycode,
                        GrabMode::ASYNC,
                        GrabMode::ASYNC,
                    )
                    .map_err(|_| budget.failure())?,
            );
        }
        let mut result = Ok(());
        for cookie in cookies {
            match cookie.check() {
                Ok(()) => {}
                Err(ReplyError::X11Error(error)) if error.error_kind == ErrorKind::Access => {
                    result = result.and(Err((
                        ErrorCode::Conflict,
                        "another X11 client already grabs this key combination",
                    )));
                }
                Err(_) => result = result.and(Err(budget.failure())),
            }
        }
        match result {
            Ok(()) => {
                self.active.insert(shortcut, Grab { keycode, mask });
                Ok(())
            }
            Err(failure) => {
                // Releasing a variant this client never acquired is a no-op;
                // another client's grab is never affected.
                self.ungrab(keycode, mask, budget)?;
                Err(failure)
            }
        }
    }

    pub(super) fn release(&mut self, shortcut: ShortcutId, budget: &Budget) -> Result<(), Failure> {
        self.connection.stream().set_budget(budget);
        match self.active.remove(&shortcut) {
            Some(grab) => self.ungrab(grab.keycode, grab.mask, budget),
            None => Ok(()),
        }
    }

    fn ungrab(&self, keycode: Keycode, mask: u16, budget: &Budget) -> Result<(), Failure> {
        for lock in self.locks.iter().copied() {
            self.connection
                .ungrab_key(keycode, self.root, ModMask::from(mask | lock))
                .map_err(|_| budget.failure())?;
        }
        // A round trip proves the server processed every ungrab before the
        // release is acknowledged to the application.
        self.connection
            .get_input_focus()
            .map_err(|_| budget.failure())?
            .reply()
            .map_err(|_| budget.failure())?;
        Ok(())
    }

    /// Returns presses for active grabs, and whether more events may be queued.
    pub(super) fn drain(&mut self, budget: &Budget) -> Result<(Vec<ShortcutId>, bool), Failure> {
        self.connection.stream().set_budget(budget);
        let relevant = self.relevant();
        let mut pressed = Vec::new();
        for _ in 0..EVENT_BUDGET {
            budget.check()?;
            let Some(event) = self
                .connection
                .poll_for_event()
                .map_err(|_| budget.failure())?
            else {
                return Ok((pressed, false));
            };
            match event {
                Event::KeyRelease(release) => {
                    self.released = Some((release.detail, release.time));
                }
                Event::KeyPress(press) => {
                    // Core X11 autorepeat sends a release and press with one
                    // timestamp; only the initial press is an activation.
                    let repeat = self.released == Some((press.detail, press.time));
                    self.released = None;
                    if repeat {
                        continue;
                    }
                    let state = u16::from(press.state) & relevant;
                    if let Some((shortcut, _)) = self
                        .active
                        .iter()
                        .find(|(_, grab)| grab.keycode == press.detail && grab.mask == state)
                    {
                        pressed.push(*shortcut);
                    }
                }
                _ => {}
            }
        }
        Ok((pressed, true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_key_set_maps_to_unshifted_keysyms() {
        assert_eq!(Key::parse("a"), Some(Key(0x61)));
        assert_eq!(Key::parse("z"), Some(Key(0x7a)));
        assert_eq!(Key::parse("0"), Some(Key(0x30)));
        assert_eq!(Key::parse("f1"), Some(Key(0xffbe)));
        assert_eq!(Key::parse("f12"), Some(Key(0xffc9)));
        for name in ["", "A", "f0", "f01", "f13", "ff", "f1x", "space", "aa"] {
            assert_eq!(Key::parse(name), None, "{name}");
        }
    }
}
