//! Native-owned hidden proof context. Renderer/view operations never receive this
//! context. A readonly verifier in the trusted Bun runtime must additionally prove
//! the persisted cookie is encrypted by the selected pinned provider.
use super::*;
use crate::session::credentials::{self, Probe};
use std::sync::Mutex;

pub(super) fn start(request: u64, args: &Value) -> Result<(), String> {
    let paths = crate::PATHS.get().ok_or("Native paths unavailable")?;
    let policy = paths
        .credential_policy
        .as_ref()
        .ok_or("UNSUPPORTED_CAPABILITY: explicit OS-cookie provider policy is not configured")?;
    let ready = STATE.with(|state| {
        let state = state.borrow();
        if state.credential_ready {
            return Ok(true);
        }
        if state.credential_probe.is_some() {
            return Err("RESOURCE_IN_USE: credential qualification already pending");
        }
        if state.sessions.len() >= 128 {
            return Err("Session limit exceeded");
        }
        Ok(false)
    })?;
    if ready {
        reply(
            request,
            json!({"ready":true,"provider":policy.provider.name(),"applicationId":policy.application_id}),
        );
        return Ok(());
    }
    let root = paths
        .profile_root
        .as_ref()
        .ok_or("Protected-cookie root unavailable")?;
    session::validate_cef_profile_path(root.path())?;
    let lease = root.acquire(
        root.path().to_str().ok_or("Invalid profile root")?,
        credentials::PROBE_PARTITION,
    )?;
    let probe = credentials::prepare_probe(&lease.path, policy, string(args, "nonce")?)?;
    let id = next_id()?;
    let settings = RequestContextSettings {
        cache_path: CefString::from(lease.path.to_string_lossy().as_ref()),
        persist_session_cookies: 1,
        ..Default::default()
    };
    let network = Arc::new(NetworkPolicy::new(None, None)?);
    let mut handler = scheme::context_handler(id, network.clone());
    let context = request_context_create_context(Some(&settings), Some(&mut handler))
        .ok_or("Credential proof context creation failed")?;
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.credential_probe = Some(id);
        state.sessions.insert(
            id,
            SessionRecord {
                context,
                profile: Some(lease),
                partition: credentials::PROBE_PARTITION.into(),
                persistent: true,
                cookies_supported: false,
                network,
                creating: Some(request),
                busy: true,
                disposing: None,
                internal_credential: true,
                credential_proof: Some(probe),
            },
        );
    });
    Ok(())
}

pub(super) fn initialized(id: u64, context: &RequestContext) {
    if QUITTING.load(Ordering::SeqCst) {
        complete(id, false, "host-stopping");
        return;
    }
    let probe = STATE.with(|state| {
        state
            .borrow()
            .sessions
            .get(&id)
            .and_then(|record| record.credential_proof.clone())
    });
    let Some(probe) = probe else {
        return;
    };
    let Some(manager) = context.cookie_manager(None) else {
        complete(id, false, "store-unavailable");
        return;
    };
    if !probe.needs_write {
        read(id, &manager, &probe);
        return;
    }
    let cookie = Cookie {
        name: CefString::from(credentials::PROBE_COOKIE),
        value: CefString::from(probe.nonce.as_str()),
        path: CefString::from("/"),
        secure: 1,
        httponly: 1,
        has_expires: 1,
        expires: unix_millis_to_basetime(4_102_444_800_000)
            .expect("fixed proof expiry is in range"),
        same_site: CookieSameSite::STRICT_MODE,
        ..Default::default()
    };
    let mut callback = ProbeWritten::new(id, context.clone());
    if manager.set_cookie(
        Some(&CefString::from(credentials::PROBE_ORIGIN)),
        Some(&cookie),
        Some(&mut callback),
    ) == 0
    {
        complete(id, false, "write-unscheduled");
    }
}
wrap_set_cookie_callback! {
    struct ProbeWritten { id:u64, context:RequestContext }
    impl SetCookieCallback { fn on_complete(&self,success:i32) {
        if success==0 { complete(self.id,false,"write-failed");return; }
        let mut task=ReadWrittenProof::new(self.id,self.context.clone());
        if post_task(ThreadId::UI,Some(&mut task))==0 {fail("Credential proof read could not be scheduled");}
    } }
}
wrap_task! {
    struct ReadWrittenProof { id:u64, context:RequestContext }
    impl Task { fn execute(&self) {
        let probe=STATE.with(|state|state.borrow().sessions.get(&self.id).and_then(|record|record.credential_proof.clone()));
        if let (Some(probe),Some(manager))=(probe,self.context.cookie_manager(None)) { read(self.id,&manager,&probe); }
        else { complete(self.id,false,"store-unavailable"); }
    } }
}
#[derive(Default)]
struct ProbeRead {
    count: usize,
    matches: bool,
}
fn read(id: u64, manager: &CookieManager, probe: &Probe) {
    let state = Arc::new(Mutex::new(ProbeRead::default()));
    let completed = state.clone();
    let completion = Arc::new(crate::cookie_completion::VisitCompletion::new(move || {
        let mut task = ProbeEnumerated::new(id, completed);
        if post_task(ThreadId::UI, Some(&mut task)) == 0 {
            fail("Credential enumeration completion could not be scheduled");
        }
    }));
    let mut visitor = ProbeCookie::new(state, probe.nonce.clone(), completion.clone());
    if manager.visit_url_cookies(
        Some(&CefString::from(credentials::PROBE_ORIGIN)),
        1,
        Some(&mut visitor),
    ) == 0
    {
        complete(id, false, "read-unscheduled");
        return;
    }
    completion.arm();
    // CEF owns the visitor until its asynchronous enumeration callback finishes,
    // including the empty result. Only its final release schedules the flush.
}
wrap_cookie_visitor! {
    struct ProbeCookie { state:Arc<Mutex<ProbeRead>>, nonce:String, completion:Arc<crate::cookie_completion::VisitCompletion> }
    impl CookieVisitor { fn visit(&self,cookie:Option<&Cookie>,count:i32,total:i32,_delete:Option<&mut i32>)->i32 {
        let mut state=self.state.lock().unwrap();
        if count != 0 || total != 1 {state.count=2;state.matches=false;return 0;}
        if let Some(cookie)=cookie {
            let name=cookie.name.to_string();
            if name!=credentials::PROBE_COOKIE {return 1;}
            state.count+=1;
            state.matches=state.count==1 && cookie.value.to_string()==self.nonce
                && cookie.domain.to_string()==credentials::PROBE_HOST
                && cookie.path.to_string()=="/" && cookie.secure!=0 && cookie.httponly!=0;
        }
        i32::from(state.count<2)
    } }
}
wrap_task! {
    struct ProbeEnumerated { id:u64, state:Arc<Mutex<ProbeRead>> }
    impl Task { fn execute(&self) {
        let context=STATE.with(|state|state.borrow().sessions.get(&self.id)
            .filter(|record| record.internal_credential && record.creating.is_some() && record.busy)
            .map(|record|record.context.clone()));
        let Some(manager)=context.and_then(|context|context.cookie_manager(None)) else {
            complete(self.id,false,"store-unavailable");return;
        };
        let mut done=ProbeFlushed::new(self.id,self.state.clone());
        if manager.flush_store(Some(&mut done))==0 { complete(self.id,false,"flush-unscheduled"); }
    } }
}
wrap_completion_callback! {
    struct ProbeFlushed { id:u64, state:Arc<Mutex<ProbeRead>> }
    impl CompletionCallback { fn on_complete(&self) {
        let valid={let state=self.state.lock().unwrap();state.count==1&&state.matches};
        complete(self.id,valid,"stored-proof-unreadable");
    } }
}
fn complete(id: u64, valid: bool, reason: &'static str) {
    // CEF cookie callbacks may arrive on its IO thread. Registry access is UI-only.
    let mut task = ProbeCompleted::new(id, valid, reason.to_owned());
    if post_task(ThreadId::UI, Some(&mut task)) == 0 {
        fail("Credential proof completion could not be scheduled");
    }
}
wrap_task! {
    struct ProbeCompleted { id:u64, valid:bool, reason:String }
    impl Task { fn execute(&self) { finish(self.id,self.valid,&self.reason); } }
}
/// Metadata only: no CEF references survive into persisted-proof verification.
/// ProfileRoot retains the native root/profile locks through CEF shutdown.
pub(super) struct RetiredProbe {
    id: u64,
    request: Option<u64>,
    proof: Probe,
    pub(super) released: bool,
    reason: String,
}

impl RetiredProbe {
    fn admission_proof(&self, id: u64) -> Result<Probe, &'static str> {
        if self.id != id || !self.released || self.request.is_some() {
            return Err("Credential proof context is not retired");
        }
        if !self.proof.native_verified {
            return Err("Native cookie proof was not verified");
        }
        Ok(self.proof.clone())
    }
}

fn finish(id: u64, valid: bool, reason: &str) {
    let context = STATE.with(|state| {
        let mut state = state.borrow_mut();
        let record = state.sessions.get_mut(&id)?;
        if !record.internal_credential {
            return None;
        }
        let request = record.creating.take()?;
        let mut proof = record.credential_proof.clone()?;
        proof.native_verified = valid;
        record.busy = false;
        record.disposing = Some(0);
        record.network.retire();
        let context = record.context.clone();
        state.retired_credential_probe = Some(RetiredProbe {
            id,
            request: Some(request),
            proof,
            released: false,
            reason: reason.into(),
        });
        Some(context)
    });
    let Some(context) = context else {
        return;
    };
    // Chromium protects its Windows cookie database with an exclusive OS handle.
    // Preserve that protection: retire our hidden context before SQLite access.
    context.clear_scheme_handler_factories();
    let mut closed = ProbeContextClosed::new(id);
    context.close_all_connections(Some(&mut closed));
}

fn context_closed(id: u64) {
    let record = STATE.with(|state| state.borrow_mut().sessions.remove(&id));
    if let Some(mut record) = record {
        drop(record.context);
        if let Some(profile) = record.profile.take() {
            session::retire(profile);
        }
    }
    // CEF posts profile keepalive release/destruction to UI; destruction then
    // posts network cleanup. Tasks below carry IDs, never retired CEF pointers.
    let mut task = ProbeReleaseUi::new(id);
    if post_task(ThreadId::UI, Some(&mut task)) == 0 {
        fail("Credential context retirement could not be scheduled");
    }
}

fn released(id: u64) {
    let completed = STATE.with(|state| {
        let mut state = state.borrow_mut();
        let retired = state.retired_credential_probe.as_mut()?;
        if retired.id != id || retired.released {
            return None;
        }
        retired.released = true;
        Some((
            retired.request.take()?,
            retired.proof.clone(),
            retired.reason.clone(),
        ))
    });
    if let Some((request, probe, reason)) = completed {
        if QUITTING.load(Ordering::SeqCst) {
            error(request, "Host stopped during credential qualification");
        } else if probe.native_verified {
            reply(
                request,
                json!({"ready":false,"id":id,"proof":{
                    "schema":1,"provider":probe.policy.provider.name(),"applicationId":probe.policy.application_id,
                    "profilePath":probe.path,"nonce":probe.nonce,"origin":credentials::PROBE_ORIGIN,
                    "cookieName":credentials::PROBE_COOKIE,"tag":probe.policy.provider.tag(),"status":"flushed-and-retired"
                }}),
            );
        } else {
            reply(
                request,
                json!({"ready":false,"id":id,"proof":{
                    "schema":1,"status":"unavailable","reason":reason
                }}),
            );
        }
    }
    if FINALIZING.load(Ordering::SeqCst) {
        finalize_sessions();
    }
}

wrap_completion_callback! {
    struct ProbeContextClosed { id:u64 }
    impl CompletionCallback { fn on_complete(&self) {
        let mut task=ProbeRetireContext::new(self.id);
        if post_task(ThreadId::UI,Some(&mut task))==0 { fail("Credential context release unavailable"); }
    } }
}
wrap_task! {
    struct ProbeRetireContext { id:u64 }
    impl Task { fn execute(&self) { context_closed(self.id); } }
}
wrap_task! {
    struct ProbeReleaseUi { id:u64 }
    impl Task { fn execute(&self) {
        let mut task=ProbeReleaseIo::new(self.id);
        if post_task(ThreadId::IO,Some(&mut task))==0 { fail("Credential IO retirement fence unavailable"); }
    } }
}
wrap_task! {
    struct ProbeReleaseIo { id:u64 }
    impl Task { fn execute(&self) {
        let mut task=ProbeReleased::new(self.id);
        if post_task(ThreadId::UI,Some(&mut task))==0 { fail("Credential UI retirement fence unavailable"); }
    } }
}
wrap_task! {
    struct ProbeReleased { id:u64 }
    impl Task { fn execute(&self) { released(self.id); } }
}

pub(super) fn accept(args: &Value) -> Result<(), String> {
    let id = number(args, "id")?;
    let probe = STATE.with(|state| {
        let state = state.borrow();
        if state.credential_ready || state.credential_probe != Some(id) {
            return Err("Credential proof is stale");
        }
        state
            .retired_credential_probe
            .as_ref()
            .ok_or("Credential proof receipt unavailable")?
            .admission_proof(id)
    })?;
    if string(args, "nonce")? != probe.nonce
        || string(args, "tag")? != probe.policy.provider.tag()
        || args.get("plaintextBytes").and_then(Value::as_u64) != Some(0)
        || !args
            .get("encryptedBytes")
            .and_then(Value::as_u64)
            .is_some_and(|bytes| (35..=8192).contains(&bytes))
    {
        return Err("Persisted cookie proof does not match native policy".into());
    }
    let hash = string(args, "ciphertextSha256")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid cookie proof digest".into());
    }
    credentials::seal_verified(&probe)?;
    credentials::Diagnostic::Admitted(&probe.policy).emit();
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.credential_ready = true;
        state.credential_probe = None;
        state.retired_credential_probe = None;
    });
    Ok(())
}

pub(super) fn discard(args: &Value) -> Result<(), String> {
    let id = number(args, "id")?;
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        if state.credential_ready || state.credential_probe != Some(id) {
            return Err("Credential proof cannot be discarded".into());
        }
        if !state
            .retired_credential_probe
            .as_ref()
            .is_some_and(|retired| {
                retired.id == id && retired.released && retired.request.is_none()
            })
        {
            return Err("Credential proof retirement is not complete".into());
        }
        if let Some(proof) = state.retired_credential_probe.as_ref() {
            credentials::Diagnostic::Unavailable(&proof.proof.policy).emit();
        }
        state.retired_credential_probe = None;
        state.credential_probe = None;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn retired() -> RetiredProbe {
        RetiredProbe {
            id: 1,
            request: Some(9),
            released: false,
            reason: "readback".into(),
            proof: Probe {
                path: std::path::PathBuf::from("unused"),
                policy: credentials::Policy {
                    application_id: "dev.bunly.test".into(),
                    provider: credentials::Provider::WindowsDpapi,
                    shared_key_scope: None,
                },
                nonce: "a".repeat(64),
                was_ready: false,
                needs_write: false,
                native_verified: true,
            },
        }
    }
    #[test]
    fn admission_requires_retirement_and_completion_of_the_exact_native_receipt() {
        let mut proof = retired();
        assert!(proof.admission_proof(1).is_err());
        proof.released = true;
        assert!(proof.admission_proof(1).is_err());
        proof.request = None;
        assert!(proof.admission_proof(1).is_ok());
        assert!(proof.admission_proof(2).is_err());
        proof.proof.native_verified = false;
        assert!(proof.admission_proof(1).is_err());
    }
    #[test]
    fn metadata_retirement_does_not_allow_an_earlier_or_pending_receipt() {
        let mut proof = retired();
        proof.released = true;
        proof.request = None;
        assert!(proof.admission_proof(1).is_ok());
        proof.released = false;
        assert!(proof.admission_proof(1).is_err());
        proof.released = true;
        proof.request = Some(10);
        assert!(proof.admission_proof(1).is_err());
    }
}
