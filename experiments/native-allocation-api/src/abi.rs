//! Diagnostic-only Heaptrack 1.5.0 ABI, from KDE's v1.5.0
//! `src/track/libheaptrack.h` (LGPL-2.1-or-later, Milian Wolff):
//! https://invent.kde.org/sdk/heaptrack/-/blob/v1.5.0/src/track/libheaptrack.h
//! Header SHA-256 fecf91761b2f785ce1f4d99a5311e5933fb1a425fabca23aed9ad66942d4d89b.
//! All callbacks are null; no C++ LineWriter object/reference is ever accessed.

use crate::{Error, Result};
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::Path;
use std::ptr::NonNull;

const RTLD_NOW: c_int = 2;
const RTLD_NOLOAD: c_int = 4;
type Callback = Option<unsafe extern "C" fn()>;
type InitializedCallback = Option<unsafe extern "C" fn(*mut c_void)>;
type Initialize = unsafe extern "C" fn(*const c_char, Callback, InitializedCallback, Callback);
type Control = unsafe extern "C" fn();

#[repr(C)]
struct DlInfo {
    filename: *const c_char,
    base: *mut c_void,
    symbol_name: *const c_char,
    symbol_address: *mut c_void,
}

#[link(name = "dl")]
unsafe extern "C" {
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
    fn dlclose(handle: *mut c_void) -> c_int;
    fn dladdr(address: *const c_void, info: *mut DlInfo) -> c_int;
}

/// Owns a loader reference on its initializing thread; neither Send nor Sync.
pub(crate) struct Api {
    library: NonNull<c_void>,
    initialize: Initialize,
    pause: Control,
    resume: Control,
    stop: Control,
    active: bool,
}

impl Api {
    pub(crate) fn load(path: &Path) -> Result<Self> {
        let encoded = CString::new(path.as_os_str().as_encoded_bytes())
            .map_err(|_| Error("profiler path contains NUL"))?;
        // SAFETY: encoded is live and NUL-terminated. NOLOAD forbids injecting a
        // new library; the explicit preload must already exist.
        let library = NonNull::new(unsafe { dlopen(encoded.as_ptr(), RTLD_NOW | RTLD_NOLOAD) })
            .ok_or(Error("the exact profiler library was not preloaded"))?;
        let symbols = (|| {
            let initialize = symbol(library, c"heaptrack_init", path)?;
            let pause = symbol(library, c"heaptrack_pause", path)?;
            let resume = symbol(library, c"heaptrack_resume", path)?;
            let stop = symbol(library, c"heaptrack_stop", path)?;
            // SAFETY: these loader-resolved addresses have the exact v1.5.0
            // declarations above; dladdr verifies their owning library. The
            // qualification controller verifies its bytes before any execution.
            Ok(Self {
                library,
                initialize: unsafe { std::mem::transmute::<*mut c_void, Initialize>(initialize) },
                pause: unsafe { std::mem::transmute::<*mut c_void, Control>(pause) },
                resume: unsafe { std::mem::transmute::<*mut c_void, Control>(resume) },
                stop: unsafe { std::mem::transmute::<*mut c_void, Control>(stop) },
                active: true,
            })
        })();
        if symbols.is_err() {
            // SAFETY: release only the successful dlopen reference owned here.
            unsafe { dlclose(library.as_ptr()) };
        }
        let mut api = symbols?;
        // Exclude all preload/startup allocations from the fresh selected file.
        api.close();
        Ok(api)
    }

    pub(crate) fn start(&mut self, output: &CStr) -> Result<()> {
        if self.active {
            return Err(Error("profiler region was opened twice"));
        }
        // SAFETY: the library reference and output stay live. Null callbacks
        // cannot invoke Rust or expose C++ objects. Previous close left the
        // global profiler paused; the independent positive/negative control
        // verifies this behavior instead of inferring it from the function name.
        unsafe {
            (self.initialize)(output.as_ptr(), None, None, None);
            (self.resume)();
        }
        self.active = true;
        Ok(())
    }

    pub(crate) fn close(&mut self) {
        if self.active {
            // SAFETY: paired, serialized control of the owned loaded library.
            // Heaptrack must not receive an unpaired second stop.
            unsafe {
                (self.pause)();
                (self.stop)();
            }
            self.active = false;
        }
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        self.close();
        // SAFETY: release our reference only. The loader retains the preload's.
        unsafe { dlclose(self.library.as_ptr()) };
    }
}

fn symbol(library: NonNull<c_void>, name: &CStr, expected: &Path) -> Result<*mut c_void> {
    // SAFETY: owned live handle and a NUL-terminated name.
    let value = unsafe { dlsym(library.as_ptr(), name.as_ptr()) };
    if value.is_null() {
        return Err(Error("required profiler ABI symbol is missing"));
    }
    let mut info = DlInfo {
        filename: std::ptr::null(),
        base: std::ptr::null_mut(),
        symbol_name: std::ptr::null(),
        symbol_address: std::ptr::null_mut(),
    };
    // SAFETY: loader-resolved address and valid writable DlInfo storage.
    if unsafe { dladdr(value, &mut info) } == 0 || info.filename.is_null() {
        return Err(Error("profiler symbol has no library identity"));
    }
    // SAFETY: successful dladdr returns a loader-owned NUL-terminated pathname;
    // the owning handle stays live throughout this function.
    let filename = unsafe { CStr::from_ptr(info.filename) }
        .to_str()
        .map_err(|_| Error("profiler symbol pathname is not UTF-8"))?;
    if Path::new(filename)
        .canonicalize()
        .map_err(|_| Error("profiler symbol library identity is unavailable"))?
        != expected
    {
        return Err(Error("profiler symbol came from another library"));
    }
    Ok(value)
}
