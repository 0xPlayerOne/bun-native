//! One native modal owner on the UI thread. A request to cancel is not closure.
//! Callers release their exact reservation only after the platform's terminal
//! callback and after removing the native UI. There is deliberately no Drop guard.
use std::cell::RefCell;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Owner {
    WindowMenu,
    FileDialog,
}

#[derive(Default)]
struct Slot {
    active: Option<(Owner, u64)>,
    next: u64,
}

impl Slot {
    fn reserve(&mut self, owner: Owner) -> Result<u64, &'static str> {
        if self.active.is_some() {
            return Err("RESOURCE_IN_USE: native modal UI is still owned");
        }
        let token = self
            .next
            .checked_add(1)
            .filter(|value| *value <= crate::rpc_protocol::MAX_ID)
            .ok_or("RESOURCE_IN_USE: native modal identity exhausted")?;
        self.next = token;
        self.active = Some((owner, token));
        Ok(token)
    }

    fn release(&mut self, owner: Owner, token: u64) -> bool {
        if self.active != Some((owner, token)) {
            return false;
        }
        self.active = None;
        true
    }
}

thread_local! { static SLOT: RefCell<Slot> = RefCell::new(Slot::default()); }

pub(super) fn reserve(owner: Owner) -> Result<u64, &'static str> {
    SLOT.with(|slot| slot.borrow_mut().reserve(owner))
}

pub(super) fn release(owner: Owner, token: u64) -> bool {
    SLOT.with(|slot| slot.borrow_mut().release(owner, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modal_reservation_cannot_be_replaced_or_released_by_another_owner() {
        let mut slot = Slot::default();
        assert_eq!(slot.reserve(Owner::WindowMenu), Ok(1));
        assert!(slot.reserve(Owner::WindowMenu).is_err());
        assert!(slot.reserve(Owner::FileDialog).is_err());
        assert!(!slot.release(Owner::FileDialog, 1));
        assert!(!slot.release(Owner::WindowMenu, 2));
        assert!(slot.release(Owner::WindowMenu, 1));
        assert!(!slot.release(Owner::WindowMenu, 1));
        assert_eq!(slot.reserve(Owner::FileDialog), Ok(2));
        assert!(!slot.release(Owner::WindowMenu, 1));
        assert!(slot.release(Owner::FileDialog, 2));
        slot.next = crate::rpc_protocol::MAX_ID;
        assert!(slot.reserve(Owner::FileDialog).is_err());
    }
}
