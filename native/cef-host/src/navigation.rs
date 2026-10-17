//! Serialize explicit navigations behind the initial document load.
//!
//! OnAfterCreated is not document readiness. CEF may report OnLoadError and
//! OnLoadEnd for the same navigation; OnLoadingStateChange(false) follows both.
//! Retire a load only at that boundary, then start its queued successor. This
//! also avoids attributing an initial same-URL load to a new explicit request.
//! See include/cef_load_handler.h in the pinned CEF distribution.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request { pub id: u64, pub url: String }
#[derive(Debug, PartialEq, Eq)]
pub struct Loaded { pub url: String, pub status: i32 }
#[derive(Default, Debug)]
pub struct Transition {
    pub completed: Option<(u64, Result<Loaded, String>)>,
    pub start: Option<Request>,
}
#[derive(Debug)]
pub struct Navigation {
    busy: bool,
    active: Option<Request>,
    queued: Option<Request>,
    outcome: Option<Result<Loaded, String>>,
}
impl Default for Navigation {
    fn default() -> Self {
        Self { busy: true, active: None, queued: None, outcome: None }
    }
}
impl Navigation {
    pub fn request(&mut self, id: u64, url: String) -> Result<Option<Request>, &'static str> {
        if self.active.is_some() || self.queued.is_some() { return Err("Navigation already pending"); }
        let request = Request { id, url };
        if self.busy { self.queued = Some(request); Ok(None) }
        else { self.busy = true; self.active = Some(request.clone()); Ok(Some(request)) }
    }
    pub fn loaded(&mut self, url: &str, status: i32) {
        if self.active.as_ref().is_some_and(|r| r.url == url)
            && !matches!(self.outcome, Some(Err(_))) {
            self.outcome = Some(Ok(Loaded { url: url.to_owned(), status }));
        }
    }
    pub fn failed(&mut self, url: &str, message: String) {
        if self.active.as_ref().is_some_and(|r| r.url == url) {
            self.outcome = Some(Err(message));
        }
    }
    pub fn redirect(&mut self, url: &str) {
        if let Some(request) = &mut self.active { request.url = url.to_owned(); }
    }
    pub fn loading(&mut self, is_loading: bool) -> Transition {
        if is_loading { self.busy = true; return Transition::default(); }
        self.busy = false;
        let completed = self.active.take().map(|request| {
            let outcome = self.outcome.take().unwrap_or_else(|| Err("Navigation ended without a matching document outcome".into()));
            (request.id, outcome)
        });
        self.outcome = None;
        let start = self.queued.take();
        if let Some(request) = &start { self.busy = true; self.active = Some(request.clone()); }
        Transition { completed, start }
    }
    /// Used for a closing view or a dispatch rejected before entering CEF.
    /// No later loading callback is guaranteed in either case.
    pub fn cancel(&mut self) -> Vec<u64> {
        self.busy = false;
        self.outcome = None;
        self.active.take().into_iter().chain(self.queued.take()).map(|r| r.id).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ready() -> Navigation { let mut n = Navigation::default(); n.loading(false); n }
    #[test]
    fn initial_abort_does_not_reject_queued_successor() {
        let mut n = Navigation::default();
        assert_eq!(n.request(7, "app://ui/new.html".into()).unwrap(), None);
        n.failed("app://ui/old.html", "ERR_ABORTED".into());
        n.loaded("app://ui/old.html", 0);
        let t = n.loading(false);
        assert!(t.completed.is_none()); assert_eq!(t.start.unwrap().id, 7);
        n.loading(true); n.loaded("app://ui/new.html", 200);
        let t = n.loading(false);
        assert_eq!(t.completed.unwrap(), (7, Ok(Loaded { url: "app://ui/new.html".into(), status: 200 })));
        assert!(t.start.is_none());
    }
    #[test]
    fn identical_initial_url_cannot_complete_a_successor() {
        let mut n = Navigation::default();
        n.request(8, "app://ui/index.html".into()).unwrap();
        n.loaded("app://ui/index.html", 200);
        let t = n.loading(false); assert!(t.completed.is_none()); assert_eq!(t.start.unwrap().id, 8);
        n.loading(true); n.failed("app://ui/index.html", "actual successor failure".into());
        assert_eq!(n.loading(false).completed.unwrap(), (8, Err("actual successor failure".into())));
    }
    #[test]
    fn error_followed_by_end_remains_a_failure() {
        let mut n = ready(); n.request(1, "app://ui/index.html".into()).unwrap();
        n.failed("app://ui/index.html", "ERR_ABORTED".into());
        n.loaded("app://ui/index.html", 200);
        assert_eq!(n.loading(false).completed.unwrap(), (1, Err("ERR_ABORTED".into())));
        assert!(n.loading(false).completed.is_none());
    }
    #[test]
    fn foreign_load_error_cannot_settle_active_request() {
        let mut n = ready(); n.request(3, "app://ui/next.html".into()).unwrap();
        n.failed("app://ui/index.html", "old failure".into());
        n.loaded("app://ui/next.html", 200);
        assert!(n.loading(false).completed.unwrap().1.is_ok());
    }
    #[test]
    fn unmatched_completion_fails_instead_of_reporting_success() {
        let mut n = ready(); n.request(3, "app://ui/next.html".into()).unwrap();
        n.loaded("app://ui/wrong.html", 200);
        assert!(n.loading(false).completed.unwrap().1.is_err());
    }
    #[test]
    fn concurrent_requests_do_not_overwrite_live_request() {
        let mut n = Navigation::default(); n.request(1, "app://ui/one".into()).unwrap();
        assert!(n.request(2, "app://ui/two".into()).is_err());
        assert_eq!(n.loading(false).start.unwrap().id, 1);
        assert!(n.request(2, "app://ui/two".into()).is_err());
    }
    #[test]
    fn closing_cancels_queued_and_active_requests_once() {
        let mut n = Navigation::default(); n.request(5, "app://ui/x".into()).unwrap();
        assert_eq!(n.cancel(), vec![5]); assert!(n.loading(false).start.is_none());
        n.request(6, "app://ui/y".into()).unwrap(); assert_eq!(n.cancel(), vec![6]);
        assert!(n.cancel().is_empty()); assert!(n.loading(false).completed.is_none());
    }
    #[test]
    fn rejected_dispatch_does_not_block_the_next_request() {
        let mut n = ready(); assert!(n.request(1, "app://ui/index.html#fragment".into()).unwrap().is_some());
        assert_eq!(n.cancel(), vec![1]);
        assert_eq!(n.request(2, "app://ui/next.html".into()).unwrap().unwrap().id, 2);
    }
    #[test]
    fn allowed_redirect_updates_expected_document() {
        let mut n = ready(); n.request(9, "app://ui/old".into()).unwrap();
        n.redirect("app://ui/new"); n.loaded("app://ui/new", 200);
        let (id, result) = n.loading(false).completed.unwrap();
        assert_eq!(id, 9); assert_eq!(result.unwrap().url, "app://ui/new");
    }
}
