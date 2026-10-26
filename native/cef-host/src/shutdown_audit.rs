//! Contributor-only lifetime accounting. Counts are not CEF reference counts or
//! proof that Chromium's internal work has drained. No wait or deadline changes.
#[derive(Clone, Copy)]
pub(crate) enum Kind {
    ContextHandler,
    SessionReady,
    FlushCallback,
    ConnectionsClosed,
}

#[derive(Clone, Default)]
pub(crate) struct Token {
    #[cfg(feature = "shutdown-diagnostics")]
    _owner: Option<std::sync::Arc<Owner>>,
}

impl Token {
    pub(crate) fn new(kind: Kind) -> Self {
        #[cfg(feature = "shutdown-diagnostics")]
        {
            LIVE[kind as usize].fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Self {
                _owner: Some(std::sync::Arc::new(Owner(kind))),
            }
        }
        #[cfg(not(feature = "shutdown-diagnostics"))]
        {
            let _ = kind;
            Self::default()
        }
    }
}

#[cfg(feature = "shutdown-diagnostics")]
static LIVE: [std::sync::atomic::AtomicUsize; 4] =
    [const { std::sync::atomic::AtomicUsize::new(0) }; 4];

#[cfg(feature = "shutdown-diagnostics")]
struct Owner(Kind);

#[cfg(feature = "shutdown-diagnostics")]
impl Drop for Owner {
    fn drop(&mut self) {
        LIVE[self.0 as usize].fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

pub(crate) fn checkpoint(stage: &'static str) {
    #[cfg(feature = "shutdown-diagnostics")]
    eprintln!(
        "{}",
        serde_json::json!({
            "event": "bunly.host.shutdown-audit", "schema": 1, "stage": stage,
            "live": LIVE.each_ref().map(|count| count.load(std::sync::atomic::Ordering::SeqCst)),
            "kinds": ["context-handler", "session-ready", "flush-callback", "connections-closed"]
        })
    );
    #[cfg(not(feature = "shutdown-diagnostics"))]
    let _ = stage;
}

#[cfg(all(test, feature = "shutdown-diagnostics"))]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn callback_completion_does_not_imply_final_reference_release() {
        let before = LIVE[Kind::FlushCallback as usize].load(Ordering::SeqCst);
        let caller = Token::new(Kind::FlushCallback);
        let retained = caller.clone();
        drop(caller);
        assert_eq!(
            LIVE[Kind::FlushCallback as usize].load(Ordering::SeqCst),
            before + 1
        );
        drop(retained);
        assert_eq!(
            LIVE[Kind::FlushCallback as usize].load(Ordering::SeqCst),
            before
        );
    }
}
