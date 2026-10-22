use crate::{
    asset_service::{Continuation, Open, Request as AssetRequest, Service},
    resources::{failure, AssetPlan, Assets},
};
use cef::*;
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
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
fn plan_request(service: &Service, request: &Request) -> AssetPlan {
    let fields = (|| {
        let url = bounded_string(request.url(), 8192)?;
        let method = bounded_string(request.method(), 16)?;
        let range = header(request, "Range", 128)?;
        let condition = header(request, "If-None-Match", 4096)?;
        let if_range = header(request, "If-Range", 256)?;
        Some(
            service
                .assets
                .plan(&url, &method, &range, &condition, &if_range),
        )
    })();
    fields.unwrap_or_else(|| AssetPlan::Immediate(failure(400)))
}
fn create_handler(request: Option<&mut Request>) -> Option<ResourceHandler> {
    let plan = plan_request(SERVICE.get()?, request?);
    Some(AssetHandler::new(Arc::new(HandlerOwner {
        request: AssetRequest::new(plan),
    })))
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
            *length = metadata.length as i64;
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
    use super::bounded_utf16;

    #[test]
    fn request_strings_are_bounded_before_utf8_allocation() {
        assert_eq!(bounded_utf16(&[65, 66], 2).as_deref(), Some("AB"));
        assert!(bounded_utf16(&[65; 17], 16).is_none());
        assert!(bounded_utf16(&[0x03bb], 1).is_none());
        assert_eq!(bounded_utf16(&[0x03bb], 2).as_deref(), Some("λ"));
        assert!(bounded_utf16(&[0xd800], 16).is_none());
        assert_eq!(bounded_utf16(&[], 0).as_deref(), Some(""));
    }
}
