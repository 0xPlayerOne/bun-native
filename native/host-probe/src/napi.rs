//! Minimal Node-API qualification adapter. Stable public C ABI, dynamically resolved
//! from Bun/Node so this fixture needs neither Node headers nor a link-time Node library.
//! Not a general native-binding layer; future production integration remains an ADR.
use std::ffi::{c_char,c_void};
use std::sync::{Mutex,OnceLock};
use std::sync::atomic::Ordering;
type Env=*mut c_void;
type Value=*mut c_void;
type Info=*mut c_void;
type Tsfn=*mut c_void;
type Callback=unsafe extern "C" fn(Env,Info)->Value;
type CallJs=unsafe extern "C" fn(Env,Value,*mut c_void,*mut c_void);
#[derive(Clone,Copy)]
struct Api {
    create_fn:unsafe extern "C" fn(Env,*const c_char,usize,Option<Callback>,*mut c_void,*mut Value)->i32,
    set:unsafe extern "C" fn(Env,Value,*const c_char,Value)->i32,
    args:unsafe extern "C" fn(Env,Info,*mut usize,*mut Value,*mut Value,*mut *mut c_void)->i32,
    uint:unsafe extern "C" fn(Env,u32,*mut Value)->i32,
    int:unsafe extern "C" fn(Env,i32,*mut Value)->i32,
    number:unsafe extern "C" fn(Env,Value,*mut f64)->i32,
    string:unsafe extern "C" fn(Env,*const c_char,usize,*mut Value)->i32,
    undefined:unsafe extern "C" fn(Env,*mut Value)->i32,
    call:unsafe extern "C" fn(Env,Value,Value,usize,*const Value,*mut Value)->i32,
    throw:unsafe extern "C" fn(Env,*const c_char,*const c_char)->i32,
    typedarray:unsafe extern "C" fn(Env,Value,*mut i32,*mut usize,*mut *mut c_void,*mut Value,*mut usize)->i32,
    create_tsfn:unsafe extern "C" fn(Env,Value,Value,Value,usize,usize,*mut c_void,Option<unsafe extern "C" fn(Env,*mut c_void,*mut c_void)>,*mut c_void,Option<CallJs>,*mut Tsfn)->i32,
    call_tsfn:unsafe extern "C" fn(Tsfn,*mut c_void,i32)->i32,
    release_tsfn:unsafe extern "C" fn(Tsfn,i32)->i32,
}
static API:OnceLock<Api>=OnceLock::new();
static TSFN:Mutex<usize>=Mutex::new(0);
unsafe fn symbol(name:&[u8])->*mut c_void {
    #[cfg(unix)] { extern "C" {fn dlsym(handle:*mut c_void,name:*const c_char)->*mut c_void;}
        #[cfg(target_os="macos")] let handle=(-2isize) as *mut c_void;
        #[cfg(not(target_os="macos"))] let handle=std::ptr::null_mut();
        dlsym(handle,name.as_ptr().cast()) }
    #[cfg(windows)] { #[link(name="kernel32")] extern "system" {
        fn GetModuleHandleW(name:*const u16)->*mut c_void;
        fn GetProcAddress(module:*mut c_void,name:*const c_char)->*mut c_void;
    }
    GetProcAddress(GetModuleHandleW(std::ptr::null()),name.as_ptr().cast()) }
}
unsafe fn load()->Option<Api> {
    macro_rules! sym {($name:literal)=>{{let p=symbol(concat!($name,"\0").as_bytes());if p.is_null(){return None;}std::mem::transmute(p)}};}
    Some(Api {create_fn:sym!("napi_create_function"),set:sym!("napi_set_named_property"),args:sym!("napi_get_cb_info"),
        uint:sym!("napi_create_uint32"),int:sym!("napi_create_int32"),number:sym!("napi_get_value_double"),
        string:sym!("napi_create_string_utf8"),undefined:sym!("napi_get_undefined"),call:sym!("napi_call_function"),
        throw:sym!("napi_throw_error"),typedarray:sym!("napi_get_typedarray_info"),create_tsfn:sym!("napi_create_threadsafe_function"),
        call_tsfn:sym!("napi_call_threadsafe_function"),release_tsfn:sym!("napi_release_threadsafe_function")})
}
unsafe fn fail(env:Env)->Value {if let Some(a)=API.get(){(a.throw)(env,b"PROBE_ERROR\0".as_ptr().cast(),b"Invalid probe call or native API failure\0".as_ptr().cast());}std::ptr::null_mut()}
unsafe fn args<const N:usize>(env:Env,info:Info)->Option<[Value;N]> {
    let mut values=[std::ptr::null_mut();N];let mut count=N;
    if (API.get()?.args)(env,info,&mut count,values.as_mut_ptr(),std::ptr::null_mut(),std::ptr::null_mut())!=0||count!=N{return None;}Some(values)
}
unsafe fn number(env:Env,value:Value)->Option<u32> {
    let mut n=0.0;if(API.get()?.number)(env,value,&mut n)!=0||!n.is_finite()||n<0.0||n>u32::MAX as f64||n.fract()!=0.0{return None;}Some(n as u32)
}
unsafe fn int(env:Env,n:i32)->Value {let mut v=std::ptr::null_mut();if(API.get().unwrap().int)(env,n,&mut v)!=0 {return fail(env);}v}
unsafe fn uint(env:Env,n:u32)->Value {let mut v=std::ptr::null_mut();if(API.get().unwrap().uint)(env,n,&mut v)!=0{return fail(env);}v}
unsafe extern "C" fn add(env:Env,info:Info)->Value {
    let Some(v)=args::<2>(env,info) else{return fail(env)};
    let(Some(a),Some(b))=(number(env,v[0]),number(env,v[1])) else{return fail(env)};uint(env,super::bunly_probe_add(a,b))
}
unsafe extern "C" fn abi(env:Env,_info:Info)->Value {uint(env,1)}
unsafe extern "C" fn mark_main(env:Env,_info:Info)->Value {int(env,super::bunly_probe_mark_main())}
unsafe extern "C" fn post(env:Env,info:Info)->Value {
    let Some(v)=args::<1>(env,info) else{return fail(env)};let Some(n)=number(env,v[0]) else{return fail(env)};int(env,super::bunly_probe_post(n))
}
unsafe extern "C" fn run(env:Env,info:Info)->Value {
    let Some(v)=args::<1>(env,info) else{return fail(env)};let Some(n)=number(env,v[0]) else{return fail(env)};int(env,super::bunly_probe_run(n))
}
unsafe extern "C" fn stop(env:Env,_info:Info)->Value {int(env,super::bunly_probe_stop())}
unsafe extern "C" fn checksum(env:Env,info:Info)->Value {
    let Some(v)=args::<1>(env,info) else{return fail(env)};
    let(mut kind,mut len,mut offset)=(0,0,0);let mut data=std::ptr::null_mut();let mut buffer=std::ptr::null_mut();
    if(API.get().unwrap().typedarray)(env,v[0],&mut kind,&mut len,&mut data,&mut buffer,&mut offset)!=0||kind!=1||len>1024*1024{return fail(env);}
    uint(env,super::bunly_probe_checksum(data.cast(),len))
}
unsafe extern "C" fn call_js(env:Env,callback:Value,_context:*mut c_void,data:*mut c_void) {
    if data.is_null(){return;}let value=*Box::from_raw(data as *mut u32);
    if env.is_null()||callback.is_null(){return;}
    let Some(a)=API.get() else{return;};let arg=uint(env,value);let mut receiver=std::ptr::null_mut();
    if(a.undefined)(env,&mut receiver)==0 {(a.call)(env,receiver,callback,1,&arg,std::ptr::null_mut());}
}
unsafe extern "C" fn set_callback(env:Env,info:Info)->Value {
    let Some(v)=args::<1>(env,info) else{return fail(env)};
    let Ok(mut slot)=TSFN.lock() else{return fail(env)};if *slot!=0{return int(env,-2);}
    let a=API.get().unwrap();let mut name=std::ptr::null_mut();
    if(a.string)(env,b"bunly-probe\0".as_ptr().cast(),usize::MAX,&mut name)!=0{return fail(env);}
    let mut f=std::ptr::null_mut();
    if(a.create_tsfn)(env,v[0],std::ptr::null_mut(),name,64,1,std::ptr::null_mut(),None,std::ptr::null_mut(),Some(call_js),&mut f)!=0{return fail(env);}
    *slot=f as usize;int(env,0)
}
unsafe extern "C" fn clear_callback(env:Env,_info:Info)->Value {
    if super::RUNNING.load(Ordering::Acquire){return int(env,-2);}
    let Ok(mut slot)=TSFN.lock() else{return fail(env)};
    if *slot!=0 {let result=(API.get().unwrap().release_tsfn)(*slot as Tsfn,0);*slot=0;return int(env,result);}int(env,0)
}
pub fn dispatch(value:u32)->i32 {
    let Ok(slot)=TSFN.lock() else{return -6};if *slot==0{return -7;}
    let Some(api)=API.get() else{return -7};let data=Box::into_raw(Box::new(value));
    let result=unsafe{(api.call_tsfn)(*slot as Tsfn,data.cast(),0)};
    if result!=0 {unsafe{drop(Box::from_raw(data));}}result
}
#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env:Env,exports:Value)->Value {
    if API.get().is_none() {let Some(api)=load() else{return std::ptr::null_mut()};let _=API.set(api);}
    let a=API.get().unwrap();
    let methods:[(&[u8],Callback);9]=[(b"abi\0",abi),(b"add\0",add),(b"checksum\0",checksum),(b"markMain\0",mark_main),
        (b"post\0",post),(b"run\0",run),(b"stop\0",stop),(b"setCallback\0",set_callback),(b"clearCallback\0",clear_callback)];
    for(name,callback) in methods {let mut function=std::ptr::null_mut();
        if(a.create_fn)(env,name.as_ptr().cast(),usize::MAX,Some(callback),std::ptr::null_mut(),&mut function)!=0||
          (a.set)(env,exports,name.as_ptr().cast(),function)!=0{return fail(env);}}
    exports
}
