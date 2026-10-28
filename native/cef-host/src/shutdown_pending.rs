//! Fixed owner/callback counts emitted only at the existing shutdown deadline.
//! Observations never release resources, call CEF, or establish successful cleanup.
use super::{HostState, FINALIZING, QUITTING};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::sync::atomic::{AtomicUsize, Ordering};

const LIMIT: usize = 65_535;

#[derive(Clone, Copy)]
pub(super) enum Point {
    FinalizeSessions,
    FinishLoop,
    IoFence,
    UiFence,
    WindowDestroyed,
    BrowserBeforeClose,
    FlushRequested,
    FlushCompleted,
    ConnectionsCloseRequested,
    ConnectionsClosed,
}

struct Counters([AtomicUsize; 10]);
impl Counters {
    const fn new() -> Self {
        Self([const { AtomicUsize::new(0) }; 10])
    }
    fn record(&self, point: Point) {
        let _ = self.0[point as usize].fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
            Some(value.saturating_add(1).min(LIMIT))
        });
    }
    fn values(&self) -> [usize; 10] {
        self.0.each_ref().map(|count| count.load(Ordering::SeqCst))
    }
}
static COUNTERS: Counters = Counters::new();

pub(super) fn record(point: Point) {
    COUNTERS.record(point);
}

pub(super) fn snapshot(state: &RefCell<HostState>) -> Value {
    let Ok(state) = state.try_borrow() else {
        // A nested native loop must not turn diagnostic observation into a
        // RefCell panic or imply that an unavailable registry is empty.
        return json!({"schema": 1, "stateAvailable": false});
    };
    snapshot_with(
        &state,
        &COUNTERS,
        QUITTING.load(Ordering::SeqCst),
        FINALIZING.load(Ordering::SeqCst),
    )
}

fn snapshot_with(
    state: &HostState,
    counters: &Counters,
    quitting: bool,
    finalizing: bool,
) -> Value {
    let owners = [
        state.windows.len(),
        state
            .windows
            .values()
            .filter(|record| record.closing.is_some())
            .count(),
        state.views.len(),
        state
            .views
            .values()
            .filter(|record| record.close.is_some())
            .count(),
        state
            .views
            .values()
            .filter(|record| record.create != 0)
            .count(),
        state
            .views
            .values()
            .filter(|record| record.browser.is_some())
            .count(),
        state
            .views
            .values()
            .filter(|record| record.view.is_some())
            .count(),
        state
            .views
            .values()
            .filter(|record| record.overlay.is_some())
            .count(),
        state.sessions.len(),
        state.sessions.values().filter(|record| record.busy).count(),
        state
            .sessions
            .values()
            .filter(|record| record.creating.is_some())
            .count(),
        state
            .sessions
            .values()
            .filter(|record| record.disposing.is_some())
            .count(),
    ];
    let counters = counters.values();
    let saturated = owners.iter().chain(&counters).any(|value| *value >= LIMIT);
    let owners = owners.map(|count| count.min(LIMIT));
    json!({
        "schema": 1,
        "stateAvailable": true,
        "quitting": quitting,
        "finalizing": finalizing,
        "saturated": saturated,
        "credentialRetirementPending": state.retired_credential_probe.as_ref().is_some_and(|probe| !probe.released),
        "owners": {
            "windows": owners[0], "windowsClosing": owners[1],
            "views": owners[2], "viewsClosing": owners[3], "viewsCreating": owners[4],
            "browserReferences": owners[5], "browserViewReferences": owners[6], "overlayReferences": owners[7],
            "sessions": owners[8], "sessionsBusy": owners[9], "sessionsCreating": owners[10], "sessionsDisposing": owners[11]
        },
        "callbacks": {
            "finalizeSessions": counters[0], "finishLoop": counters[1], "ioFence": counters[2], "uiFence": counters[3],
            "windowDestroyed": counters[4], "browserBeforeClose": counters[5],
            "flushRequested": counters[6], "flushCompleted": counters[7],
            "connectionsCloseRequested": counters[8], "connectionsClosed": counters[9]
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_snapshot_counts_owned_records_without_exporting_their_identity_or_content() {
        let (mut state, _) = super::super::tests::state_with_view(7, 11);
        let view = state.views.get_mut(&7).unwrap();
        view.expected_document_url = "https://private.invalid/profile?secret=fixture".into();
        view.create = 13;
        view.close = Some(17);
        state.windows.insert(
            11,
            super::super::WindowRecord {
                window: None,
                request: 19,
                closing: Some(23),
                close_batch: Default::default(),
                view_layout: super::super::view_composition::LayoutMode::Manual,
            },
        );
        let counters = Counters::new();
        counters.record(Point::WindowDestroyed);
        counters.record(Point::FinalizeSessions);
        counters.record(Point::FinalizeSessions);
        let snapshot = snapshot_with(&state, &counters, true, false);
        assert_eq!(
            snapshot["owners"],
            json!({
                "windows": 1, "windowsClosing": 1,
                "views": 1, "viewsClosing": 1, "viewsCreating": 1,
                "browserReferences": 0, "browserViewReferences": 0, "overlayReferences": 0,
                "sessions": 0, "sessionsBusy": 0, "sessionsCreating": 0, "sessionsDisposing": 0
            })
        );
        assert_eq!(snapshot["callbacks"]["windowDestroyed"], 1);
        assert_eq!(snapshot["callbacks"]["finalizeSessions"], 2);
        assert_eq!(snapshot["callbacks"]["browserBeforeClose"], 0);
        assert_eq!(snapshot["quitting"], true);
        assert_eq!(snapshot["finalizing"], false);
        assert_eq!(snapshot["saturated"], false);
        let encoded = snapshot.to_string();
        assert!(!encoded.contains("private.invalid"));
        assert!(!encoded.contains("fixture"));
        assert!(!encoded.contains("https://"));
        // Observation cannot consume native owners or manufacture close callbacks.
        assert_eq!(state.views.len(), 1);
        assert_eq!(state.windows.len(), 1);
        assert_eq!(state.views.get(&7).unwrap().close, Some(17));
    }

    #[test]
    fn repeated_callbacks_remain_bounded_and_saturation_is_explicit() {
        let counters = Counters::new();
        counters.0[Point::FlushCompleted as usize].store(LIMIT, Ordering::SeqCst);
        counters.record(Point::FlushCompleted);
        let snapshot = snapshot_with(&HostState::default(), &counters, true, true);
        assert_eq!(snapshot["callbacks"]["flushCompleted"], LIMIT);
        assert_eq!(snapshot["saturated"], true);
        assert_eq!(snapshot["callbacks"]["uiFence"], 0);
        assert_eq!(snapshot["owners"]["views"], 0);
    }

    #[test]
    fn a_borrowed_registry_reports_unavailable_without_panicking_or_inventing_zero_owners() {
        let state = RefCell::new(HostState::default());
        let borrowed = state.borrow_mut();
        assert_eq!(
            snapshot(&state),
            json!({"schema": 1, "stateAvailable": false})
        );
        drop(borrowed);
        assert_eq!(snapshot(&state)["stateAvailable"], true);
    }
}
