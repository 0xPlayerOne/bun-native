use crate::{
    asset_service::{Continuation, Open, Request as AssetRequest, ResponseMetadata, Service},
    network_policy::NetworkPolicy,
    resources::{failure, AssetPlan, Assets},
};
use cef::*;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
static SERVICE: OnceLock<Service> = OnceLock::new();

#[must_use = "the asset service must stay alive until CEF work has stopped"]
pub struct ServiceGuard;
impl Drop for ServiceGuard {
    fn drop(&mut self) {
        if let Some(service) = SERVICE.get() {
            service.shutdown();
        }
    }
}
pub fn load(root: PathBuf) -> Result<ServiceGuard, String> {
    let service = Service::new(Assets::load(&root)?).map_err(|error| error.to_string())?;
    SERVICE
        .set(service)
        .map_err(|_| "Assets already configured".to_owned())?;
    Ok(ServiceGuard)
}
pub fn register(registrar: Option<&mut SchemeRegistrar>) {
    if let Some(r) = registrar {
        let options = SchemeOptions::STANDARD.get_raw()
            | SchemeOptions::SECURE.get_raw()
            | SchemeOptions::CORS_ENABLED.get_raw()
            | SchemeOptions::FETCH_ENABLED.get_raw();
        #[cfg(not(target_os = "windows"))]
        let options = options as i32;
        r.add_custom_scheme(Some(&CefString::from("app")), options);
    }
}
pub fn attach(context: &RequestContext) {
    let mut factory = AppFactory::new();
    context.register_scheme_handler_factory(
        Some(&CefString::from("app")),
        Some(&CefString::from("ui")),
        Some(&mut factory),
    );
}
pub(crate) fn context_handler(session: u64, network: Arc<NetworkPolicy>) -> RequestContextHandler {
    AssetContext::new(
        session,
        network,
        crate::shutdown_audit::Token::new(crate::shutdown_audit::Kind::ContextHandler),
    )
}
pub(crate) fn local_resources(network: Arc<NetworkPolicy>) -> ResourceRequestHandler {
    LocalResources::new(Arc::new(RequestPreparation::default()), network)
}
fn bounded_utf16(value: &[u16], limit: usize) -> Option<String> {
    if value.len() > limit {
        return None;
    }
    // UTF-8 conversion is bounded by at most three bytes per UTF-16 code unit.
    String::from_utf16(value)
        .ok()
        .filter(|value| value.len() <= limit)
}
fn bounded_string(value: cef::string::CefStringUserfreeUtf16, limit: usize) -> Option<String> {
    let raw: Option<&sys::_cef_string_utf16_t> = (&value).into();
    let Some(raw) = raw else {
        return Some(String::new());
    };
    if raw.length > limit || (raw.length != 0 && raw.str_.is_null()) {
        return None;
    }
    // Borrow the owned CEF value instead of first duplicating arbitrary-sized input.
    let borrowed = CefString::from(*raw);
    bounded_utf16(borrowed.as_slice().unwrap_or_default(), limit)
}
fn header(request: &Request, name: &str, limit: usize) -> Option<String> {
    bounded_string(request.header_by_name(Some(&CefString::from(name))), limit)
}
fn plan_request(service: &Service, request: &Request) -> (AssetPlan, bool) {
    let range = header(request, "Range", 128);
    let normalize_range = range.as_ref().is_none_or(|range| !range.is_empty());
    let fields = (|| {
        let url = bounded_string(request.url(), 8192)?;
        let method = bounded_string(request.method(), 16)?;
        let range = range?;
        let condition = header(request, "If-None-Match", 4096)?;
        let if_range = header(request, "If-Range", 256)?;
        Some(
            service
                .assets
                .plan(&url, &method, &range, &condition, &if_range),
        )
    })();
    (
        fields.unwrap_or_else(|| AssetPlan::Immediate(failure(400))),
        normalize_range,
    )
}
fn create_handler(request: Option<&mut Request>) -> Option<ResourceHandler> {
    let (plan, _) = plan_request(SERVICE.get()?, request?);
    Some(AssetHandler::new(Arc::new(HandlerOwner {
        request: AssetRequest::new(plan),
    })))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RequestKey {
    identifier: u64,
    url: String,
    method: String,
}
impl RequestKey {
    fn read(request: &Request) -> Option<Self> {
        Some(Self {
            identifier: request.identifier(),
            url: bounded_string(request.url(), 4096)?,
            method: bounded_string(request.method(), 16)?,
        })
    }
}
#[derive(Default)]
enum Preparation {
    #[default]
    New,
    Preparing,
    Ready {
        key: RequestKey,
        owner: Option<Arc<HandlerOwner>>,
    },
    Unavailable,
}
#[derive(Default)]
struct RequestPreparation {
    state: Mutex<Preparation>,
}
impl RequestPreparation {
    fn begin(&self) -> bool {
        let previous = {
            let mut state = self.state.lock().unwrap();
            let next = if matches!(*state, Preparation::New) {
                Preparation::Preparing
            } else {
                Preparation::Unavailable
            };
            std::mem::replace(&mut *state, next)
        };
        // Drop any superseded owner outside the state lock.
        matches!(previous, Preparation::New)
    }
    fn finish(&self, key: RequestKey, owner: Option<Arc<HandlerOwner>>) -> bool {
        let mut state = self.state.lock().unwrap();
        if !matches!(*state, Preparation::Preparing) {
            return false;
        }
        *state = Preparation::Ready { key, owner };
        true
    }
    fn take(&self, key: Option<&RequestKey>) -> Result<Option<Arc<HandlerOwner>>, ()> {
        let previous = {
            let mut state = self.state.lock().unwrap();
            std::mem::replace(&mut *state, Preparation::Unavailable)
        };
        match previous {
            Preparation::Ready {
                key: expected,
                owner,
            } if key == Some(&expected) => Ok(owner),
            _ => Err(()),
        }
    }
    fn prepare(&self, request: Option<&mut Request>, network: &NetworkPolicy) -> ReturnValue {
        let Some(request) = request else {
            return ReturnValue::CANCEL;
        };
        if request.is_read_only() != 0 {
            return ReturnValue::CANCEL;
        }
        let Some(key) = RequestKey::read(request) else {
            return ReturnValue::CANCEL;
        };
        let Ok(url) = network.navigation(&key.url) else {
            return ReturnValue::CANCEL;
        };
        // HTTP requests (including each redirect) have no packaged asset plan.
        // Never reuse their first URL as authority for the redirected target.
        if !url.starts_with("app:") {
            return ReturnValue::CONTINUE;
        }
        if !self.begin() {
            return ReturnValue::CANCEL;
        }
        let owner = if url.starts_with("app:") {
            let Some(service) = SERVICE.get() else {
                return ReturnValue::CANCEL;
            };
            let (plan, normalize_range) = plan_request(service, request);
            // CEF applies Range before asking for response headers. The plan has
            // already selected and bounded the original range; let CEF skip zero
            // bytes and take the verified response's actual length instead.
            if normalize_range {
                request.set_header_by_name(
                    Some(&CefString::from("Range")),
                    Some(&CefString::from("bytes=0-")),
                    1,
                );
            }
            Some(Arc::new(HandlerOwner {
                request: AssetRequest::new(plan),
            }))
        } else {
            None
        };
        if self.finish(key, owner) {
            ReturnValue::CONTINUE
        } else {
            ReturnValue::CANCEL
        }
    }
    fn handler(
        &self,
        request: Option<&mut Request>,
        network: &NetworkPolicy,
    ) -> Option<ResourceHandler> {
        let key = request.as_deref().and_then(RequestKey::read);
        match key
            .as_ref()
            .and_then(|key| network.navigation(&key.url).ok())
        {
            Some(url) if !url.starts_with("app:") => return None,
            Some(_) => (),
            None => {
                // Dispose a prepared asset owner as well when the session retires
                // between OnBeforeResourceLoad and GetResourceHandler.
                drop(self.take(key.as_ref()));
                return Some(AssetHandler::new(Arc::new(HandlerOwner {
                    request: AssetRequest::new(AssetPlan::Immediate(failure(403))),
                })));
            }
        }
        match self.take(key.as_ref()) {
            Ok(Some(owner)) => Some(AssetHandler::new(owner)),
            Ok(None) => None,
            Err(()) => Some(AssetHandler::new(Arc::new(HandlerOwner {
                request: AssetRequest::new(AssetPlan::Immediate(failure(400))),
            }))),
        }
    }
}

fn response_length(metadata: &ResponseMetadata) -> i64 {
    if metadata.length == 0
        && metadata.headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("Content-Length")
                && value.parse::<u64>().is_ok_and(|length| length > 0)
        })
    {
        // HEAD has a representation length but no body. With -1 CEF preserves
        // our explicit header instead of synthesizing Content-Length: 0, and
        // the first read still terminates immediately at EOF.
        -1
    } else {
        metadata.length as i64
    }
}
struct HandlerOwner {
    request: Arc<AssetRequest>,
}
impl Drop for HandlerOwner {
    fn drop(&mut self) {
        self.request.cancel();
    }
}
impl HandlerOwner {
    fn open(&self, handle: Option<&mut i32>, callback: Option<&mut Callback>) -> i32 {
        let Some(handle) = handle else {
            return 0;
        };
        *handle = 1;
        let Some(callback) = callback else {
            return 0;
        };
        let Some(service) = SERVICE.get() else {
            return 0;
        };
        let callback = callback.clone();
        *handle = 0;
        let request = self.request.clone();
        match self.request.start(service, move |continuation| {
            let mut task = AssetReady::new(request.clone(), callback, continuation);
            if post_task(ThreadId::IO, Some(&mut task)) == 0 {
                request.cancel();
            }
        }) {
            Open::Pending => 1,
            Open::Ready => {
                *handle = 1;
                1
            }
            Open::Cancelled => {
                *handle = 1;
                0
            }
        }
    }
    fn headers(&self, response: Option<&mut Response>, length: Option<&mut i64>) {
        let Some(metadata) = self.request.headers() else {
            if let Some(length) = length {
                *length = 0;
            }
            return;
        };
        // The bounded metadata snapshot releases our lock before calling CEF.
        if let Some(length) = length {
            *length = response_length(&metadata);
        }
        if let Some(response) = response {
            response.set_status(metadata.status);
            response.set_mime_type(Some(&CefString::from(metadata.mime.as_str())));
            for (key, value) in metadata.headers {
                response.set_header_by_name(
                    Some(&CefString::from(key.as_str())),
                    Some(&CefString::from(value.as_str())),
                    1,
                );
            }
        }
    }
    // Safety: CEF supplies writable requested-byte storage until this callback returns.
    unsafe fn read(&self, out: *mut u8, requested: i32, written: Option<&mut i32>) -> i32 {
        let Some(written) = written else {
            return 0;
        };
        *written = 0;
        if out.is_null() || requested <= 0 {
            return 0;
        }
        let capacity = (requested as usize).min(crate::resources::MAX_ASSET_BYTES as usize);
        let bytes = unsafe { std::slice::from_raw_parts_mut(out, capacity) };
        let count = self.request.read(bytes);
        *written = count as i32;
        i32::from(count > 0)
    }
}
wrap_request_context_handler! {
    struct AssetContext { session: u64, network: Arc<NetworkPolicy>, _audit: crate::shutdown_audit::Token }
    impl RequestContextHandler {
        fn on_request_context_initialized(&self, context: Option<&mut RequestContext>) {
            if let Some(context) = context { crate::host::session_initialized(self.session, context.clone()); }
        }
        fn resource_request_handler(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _request: Option<&mut Request>,
            _navigation: i32,
            _download: i32,
            _initiator: Option<&CefString>,
            _disable_default: Option<&mut i32>,
        ) -> Option<ResourceRequestHandler> {
            Some(local_resources(self.network.clone()))
        }
    }
}
wrap_resource_request_handler! {
    struct LocalResources { preparation: Arc<RequestPreparation>, network: Arc<NetworkPolicy> }
    impl ResourceRequestHandler {
        fn on_before_resource_load(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            request: Option<&mut Request>,
            _callback: Option<&mut Callback>,
        ) -> ReturnValue {
            self.preparation.prepare(request, &self.network)
        }
        fn resource_handler(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            request: Option<&mut Request>,
        ) -> Option<ResourceHandler> {
            self.preparation.handler(request, &self.network)
        }
        fn on_resource_redirect(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>,
            _request: Option<&mut Request>, _response: Option<&mut Response>, new_url: Option<&mut CefString>) {
            if let Some(new_url) = new_url {
                let allowed = bounded_utf16(new_url.as_slice().unwrap_or_default(), 4096)
                    .is_some_and(|value| self.network.navigation(&value).is_ok());
                if !allowed && !new_url.try_set("bunly-denied://resource-redirect") {
                    crate::host::fail("Unable to reject resource redirect");
                }
            }
        }
        fn on_protocol_execution(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _request: Option<&mut Request>,
            allow: Option<&mut i32>,
        ) {
            if let Some(allow) = allow { *allow = 0; }
        }
    }
}
wrap_scheme_handler_factory! {
    struct AppFactory;
    impl SchemeHandlerFactory {
        fn create(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _scheme: Option<&CefString>,
            request: Option<&mut Request>,
        ) -> Option<ResourceHandler> {
            create_handler(request)
        }
    }
}
wrap_resource_handler! {
    struct AssetHandler { owner: Arc<HandlerOwner> }
    impl ResourceHandler {
        fn open(
            &self,
            _request: Option<&mut Request>,
            handle: Option<&mut i32>,
            callback: Option<&mut Callback>,
        ) -> i32 {
            self.owner.open(handle, callback)
        }
        fn response_headers(
            &self,
            response: Option<&mut Response>,
            length: Option<&mut i64>,
            _redirect: Option<&mut CefString>,
        ) {
            self.owner.headers(response, length);
        }
        fn read(
            &self,
            out: *mut u8,
            requested: i32,
            written: Option<&mut i32>,
            _callback: Option<&mut ResourceReadCallback>,
        ) -> i32 {
            // Safety: CEF owns and sizes the output buffer for this invocation.
            unsafe { self.owner.read(out, requested, written) }
        }
        fn cancel(&self) {
            self.owner.request.cancel();
        }
    }
}

// Continue on CEF IO, where native cancellation is delivered; do not retain a handler pointer.
wrap_task! {
    struct AssetReady {
        request: Arc<AssetRequest>,
        callback: Callback,
        _continuation: Continuation,
    }
    impl Task {
        fn execute(&self) {
            self.request.continue_if_live(|| self.callback.cont());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_strings_are_bounded_before_utf8_allocation() {
        assert_eq!(bounded_utf16(&[65, 66], 2).as_deref(), Some("AB"));
        assert!(bounded_utf16(&[65; 17], 16).is_none());
        assert!(bounded_utf16(&[0x03bb], 1).is_none());
        assert_eq!(bounded_utf16(&[0x03bb], 2).as_deref(), Some("λ"));
        assert!(bounded_utf16(&[0xd800], 16).is_none());
        assert_eq!(bounded_utf16(&[], 0).as_deref(), Some(""));
    }

    fn request_key() -> RequestKey {
        RequestKey {
            identifier: 7,
            url: "app://ui/index.html".into(),
            method: "GET".into(),
        }
    }
    #[test]
    fn prepared_plans_cannot_be_replayed_or_replaced_by_normalized_metadata() {
        let preparation = RequestPreparation::default();
        assert!(preparation.begin());
        let owner = Arc::new(HandlerOwner {
            request: AssetRequest::new(AssetPlan::Immediate(failure(404))),
        });
        assert!(preparation.finish(request_key(), Some(owner.clone())));
        assert!(Arc::ptr_eq(
            &preparation.take(Some(&request_key())).unwrap().unwrap(),
            &owner
        ));
        assert!(preparation.take(Some(&request_key())).is_err());
        assert!(!preparation.begin());
        assert!(!preparation.finish(request_key(), None));

        let repeated = RequestPreparation::default();
        assert!(repeated.begin());
        assert!(!repeated.begin());
        assert!(!repeated.finish(request_key(), None));
        assert!(repeated.take(Some(&request_key())).is_err());
    }
    #[test]
    fn prepared_requests_require_the_original_identifier_url_and_method() {
        for key in [
            None,
            Some(RequestKey {
                identifier: 8,
                ..request_key()
            }),
            Some(RequestKey {
                url: "app://ui/other.html".into(),
                ..request_key()
            }),
            Some(RequestKey {
                method: "HEAD".into(),
                ..request_key()
            }),
        ] {
            let preparation = RequestPreparation::default();
            assert!(preparation.begin());
            assert!(preparation.finish(request_key(), None));
            assert!(preparation.take(key.as_ref()).is_err());
            assert!(preparation.take(Some(&request_key())).is_err());
        }
        let passthrough = RequestPreparation::default();
        assert!(passthrough.begin());
        assert!(passthrough.finish(request_key(), None));
        assert!(passthrough.take(Some(&request_key())).unwrap().is_none());
    }
    #[test]
    fn cef_lengths_preserve_head_headers_without_sending_a_body() {
        let mut metadata = ResponseMetadata {
            status: 200,
            mime: "text/plain".into(),
            headers: vec![("Content-Length".into(), "10".into())],
            length: 0,
        };
        assert_eq!(response_length(&metadata), -1);
        metadata.length = 10;
        assert_eq!(response_length(&metadata), 10);
        metadata.status = 206;
        metadata.length = 4;
        metadata.headers[0].1 = "4".into();
        assert_eq!(response_length(&metadata), 4);
        metadata.status = 304;
        metadata.length = 0;
        metadata.headers.clear();
        assert_eq!(response_length(&metadata), 0);
        metadata.status = 416;
        metadata.headers.push(("Content-Length".into(), "0".into()));
        assert_eq!(response_length(&metadata), 0);
    }
}
