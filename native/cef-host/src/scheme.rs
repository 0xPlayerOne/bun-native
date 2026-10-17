use crate::resources::{AssetResponse, Assets};
use cef::*;
use std::{
    cell::Cell,
    path::PathBuf,
    sync::{Arc, OnceLock},
};
static ASSETS: OnceLock<Assets> = OnceLock::new();
pub fn load(root: PathBuf) -> Result<(), String> {
    ASSETS
        .set(Assets::load(&root)?)
        .map_err(|_| "Assets already configured".into())
}
pub fn register(registrar: Option<&mut SchemeRegistrar>) {
    if let Some(r) = registrar {
        r.add_custom_scheme(
            Some(&CefString::from("app")),
            (SchemeOptions::STANDARD.get_raw()
                | SchemeOptions::SECURE.get_raw()
                | SchemeOptions::CORS_ENABLED.get_raw()
                | SchemeOptions::FETCH_ENABLED.get_raw()) as i32,
        );
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
wrap_scheme_handler_factory! {
    struct AppFactory;
    impl SchemeHandlerFactory{
        fn create(&self,_browser:Option<&mut Browser>,_frame:Option<&mut Frame>,_scheme:Option<&CefString>,request:Option<&mut Request>)->Option<ResourceHandler>{
            let request=request?;
            let url=CefString::from(&request.url()).to_string();
            let method=CefString::from(&request.method()).to_string();
            let range=CefString::from(&request.header_by_name(Some(&CefString::from("Range")))).to_string();
            let if_none_match=CefString::from(&request.header_by_name(Some(&CefString::from("If-None-Match")))).to_string();
            let if_range=CefString::from(&request.header_by_name(Some(&CefString::from("If-Range")))).to_string();
            let result=ASSETS.get()?.conditional_response(&url,&method,&range,&if_none_match,&if_range);
            // CEF wrapper state must be cloneable; share the immutable response
            // instead of copying the entire public asset for each wrapper clone.
            Some(AssetHandler::new(Arc::new(result),Cell::new(0)))
        }
    }
}
wrap_resource_handler! {
    struct AssetHandler{result:Arc<AssetResponse>,position:Cell<usize>}
    impl ResourceHandler{
        fn open(&self,_request:Option<&mut Request>,handle:Option<&mut i32>,_callback:Option<&mut Callback>)->i32{if let Some(h)=handle{*h=1;}1}
        fn response_headers(&self,response:Option<&mut Response>,length:Option<&mut i64>,_redirect:Option<&mut CefString>){
            if let Some(r)=response{r.set_status(self.result.status);r.set_mime_type(Some(&CefString::from(self.result.mime.as_str())));for(k,v)in &self.result.headers{r.set_header_by_name(Some(&CefString::from(k.as_str())),Some(&CefString::from(v.as_str())),1);}}
            if let Some(n)=length{*n=self.result.body.len() as i64;}
        }
        fn read(&self,out:*mut u8,requested:i32,written:Option<&mut i32>,_callback:Option<&mut ResourceReadCallback>)->i32{
            let Some(written)=written else{return 0};*written=0;
            if out.is_null()||requested<=0{return 0;}
            let start=self.position.get();let count=(requested as usize).min(self.result.body.len().saturating_sub(start));
            if count==0{return 0;}
            // CEF owns a writable requested-byte output buffer; source/count are checked.
            unsafe{std::ptr::copy_nonoverlapping(self.result.body.as_ptr().add(start),out,count);}
            self.position.set(start+count);*written=count as i32;1
        }
    }
}
