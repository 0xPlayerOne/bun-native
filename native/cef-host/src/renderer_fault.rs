//! Contributor-only, single-flight main-frame fault handshake. Metadata only:
//! no process IDs, executable names, callbacks, native handles, or repeated timer.
use crate::rpc_protocol::{Identity, MAX_ID};
use std::cell::RefCell;

#[derive(Default)]
struct Pending(Option<(u64, u64, Identity)>);
impl Pending {
    fn begin(&mut self, view: u64, request: u64, identity: Identity) -> Result<(), &'static str> {
        if self.0.is_some() || view == 0 || view > MAX_ID || request == 0 || request > MAX_ID {
            return Err("Renderer fault already pending or invalid");
        }
        self.0 = Some((view, request, identity));
        Ok(())
    }
    fn acknowledged(&mut self, view: u64, identity: Identity) -> Option<u64> {
        let pending = self.0?;
        if pending.0 != view || pending.2 != identity {
            return None;
        }
        self.0.take().map(|(_, request, _)| request)
    }
}
thread_local! { static PENDING: RefCell<Pending> = RefCell::new(Pending::default()); }
pub fn begin(view: u64, request: u64, identity: Identity) -> Result<(), &'static str> {
    PENDING.with(|pending| pending.borrow_mut().begin(view, request, identity))
}
pub fn acknowledged(view: u64, identity: Identity) -> Option<u64> {
    PENDING.with(|pending| pending.borrow_mut().acknowledged(view, identity))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_one_exact_view_and_document_ack_can_commit_the_fault() {
        let identity = Identity {
            context: 3,
            connection: 4,
            generation: 5,
        };
        let mut pending = Pending::default();
        assert_eq!(pending.acknowledged(1, identity), None);
        pending.begin(1, 2, identity).unwrap();
        assert!(pending.begin(1, 3, identity).is_err());
        assert_eq!(pending.acknowledged(2, identity), None);
        for foreign in [
            Identity {
                context: 9,
                ..identity
            },
            Identity {
                connection: 9,
                ..identity
            },
            Identity {
                generation: 9,
                ..identity
            },
        ] {
            assert_eq!(pending.acknowledged(1, foreign), None);
        }
        assert_eq!(pending.acknowledged(1, identity), Some(2));
        assert_eq!(pending.acknowledged(1, identity), None);
        for (view, request) in [(0, 1), (1, 0), (MAX_ID + 1, 1), (1, MAX_ID + 1)] {
            assert!(pending.begin(view, request, identity).is_err());
        }
    }
}
