//! RenderDoc integration - <https://renderdoc.org/>
#![cfg_attr(not(any(feature = "gles", feature = "vulkan")), allow(dead_code))]

use alloc::format;
use alloc::string::String;
use core::{ffi, ptr};

/// The dynamically loaded RenderDoc API function table
#[repr(C)]
#[derive(Debug)]
pub struct RenderDocApi {
    api: renderdoc_sys::RENDERDOC_API_1_4_1,
    lib: libloading::Library,
}

unsafe impl Send for RenderDocApi {}
unsafe impl Sync for RenderDocApi {}

/// RenderDoc API type
#[derive(Debug)]
pub enum RenderDoc {
    /// RenderDoc functionality is available
    Available {
        /// RenderDoc API with function pointers
        api: RenderDocApi,
    },
    /// RenderDoc functionality is _not_ available
    NotAvailable {
        /// A description why renderdoc functionality is not available
        reason: String,
    },
}

// TODO: replace with libloading API once supported
#[cfg(unix)]
const RTLD_NOLOAD: i32 = 0x4;

type GetApiFn = unsafe extern "C" fn(version: u32, out: *mut *mut ffi::c_void) -> i32;

#[derive(Debug, PartialEq, Eq)]
enum ApiLoadError {
    Status(i32),
    NullTable,
}

/// Query the existing RenderDoc ABI without dereferencing a null success result.
///
/// # Safety
///
/// The caller must supply the real GetAPI ABI and keep its library loaded while
/// using the copied function pointers. A non-null success result must still
/// point to a readable, initialized table; a null check cannot establish that.
unsafe fn query_api(get_api: GetApiFn) -> Result<renderdoc_sys::RENDERDOC_API_1_4_1, ApiLoadError> {
    let mut obj = ptr::null_mut();
    let status = unsafe { get_api(10401, &mut obj) };
    if status != 1 {
        return Err(ApiLoadError::Status(status));
    }
    let obj = ptr::NonNull::new(obj.cast::<renderdoc_sys::RENDERDOC_API_1_4_1>())
        .ok_or(ApiLoadError::NullTable)?;
    // SAFETY: The foreign API's successful non-null output supplies the table;
    // the caller retains the library that owns its function pointers.
    Ok(unsafe { *obj.as_ptr() })
}

impl RenderDoc {
    pub unsafe fn new() -> Self {
        #[cfg(windows)]
        let renderdoc_filename = "renderdoc.dll";
        #[cfg(all(unix, not(target_os = "android")))]
        let renderdoc_filename = "librenderdoc.so";
        #[cfg(target_os = "android")]
        let renderdoc_filename = "libVkLayer_GLES_RenderDoc.so";

        #[cfg(unix)]
        let renderdoc_result: Result<libloading::Library, libloading::Error> = unsafe {
            libloading::os::unix::Library::open(
                Some(renderdoc_filename),
                libloading::os::unix::RTLD_NOW | RTLD_NOLOAD,
            )
        }
        .map(|lib| lib.into());

        #[cfg(windows)]
        let renderdoc_result: Result<libloading::Library, libloading::Error> =
            libloading::os::windows::Library::open_already_loaded(renderdoc_filename)
                .map(|lib| lib.into());

        let renderdoc_lib = match renderdoc_result {
            Ok(lib) => lib,
            Err(e) => {
                return RenderDoc::NotAvailable {
                    reason: format!(
                        "Unable to load renderdoc library '{renderdoc_filename}': {e:?}"
                    ),
                }
            }
        };

        let get_api: libloading::Symbol<GetApiFn> =
            match unsafe { renderdoc_lib.get(c"RENDERDOC_GetAPI".to_bytes()) } {
                Ok(api) => api,
                Err(e) => {
                    return RenderDoc::NotAvailable {
                        reason: format!(
                            "Unable to get RENDERDOC_GetAPI from renderdoc library '{renderdoc_filename}': {e:?}"
                        ),
                    }
                }
            };
        match unsafe { query_api(*get_api) } {
            Ok(api) => RenderDoc::Available {
                api: RenderDocApi {
                    api,
                    lib: renderdoc_lib,
                },
            },
            Err(ApiLoadError::Status(return_value)) => RenderDoc::NotAvailable {
                reason: format!(
                    "Unable to get API from renderdoc library '{renderdoc_filename}': {return_value}"
                ),
            },
            Err(ApiLoadError::NullTable) => RenderDoc::NotAvailable {
                reason: format!(
                    "Renderdoc library '{renderdoc_filename}' returned a null API table on success"
                ),
            },
        }
    }
}

impl Default for RenderDoc {
    fn default() -> Self {
        if !cfg!(debug_assertions) {
            return RenderDoc::NotAvailable {
                reason: "RenderDoc support is only enabled with 'debug_assertions'".into(),
            };
        }
        unsafe { Self::new() }
    }
}
/// An implementation specific handle
pub type Handle = *mut ffi::c_void;

impl RenderDoc {
    /// Start a RenderDoc frame capture
    pub unsafe fn start_frame_capture(&self, device_handle: Handle, window_handle: Handle) -> bool {
        match *self {
            Self::Available { api: ref entry } => {
                unsafe { entry.api.StartFrameCapture.unwrap()(device_handle, window_handle) };
                true
            }
            Self::NotAvailable { ref reason } => {
                log::warn!("Could not start RenderDoc frame capture: {reason}");
                false
            }
        }
    }

    /// End a RenderDoc frame capture
    pub unsafe fn end_frame_capture(&self, device_handle: Handle, window_handle: Handle) {
        match *self {
            Self::Available { api: ref entry } => {
                unsafe { entry.api.EndFrameCapture.unwrap()(device_handle, window_handle) };
            }
            Self::NotAvailable { ref reason } => {
                log::warn!("Could not end RenderDoc frame capture: {reason}")
            }
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe extern "C" fn version(major: *mut i32, minor: *mut i32, patch: *mut i32) {
        unsafe {
            *major = 1;
            *minor = 4;
            *patch = 1;
        }
    }

    static API: renderdoc_sys::RENDERDOC_API_1_4_1 = {
        // Every generated field is a nullable function pointer (or a union of
        // those pointers). Zero initializes None; only the known stub is called.
        let mut api: renderdoc_sys::RENDERDOC_API_1_4_1 = unsafe { core::mem::zeroed() };
        api.GetAPIVersion = Some(version);
        api
    };

    unsafe extern "C" fn failed_null(_version: u32, out: *mut *mut ffi::c_void) -> i32 {
        unsafe { *out = ptr::null_mut() };
        0
    }

    unsafe extern "C" fn successful_null(_version: u32, out: *mut *mut ffi::c_void) -> i32 {
        unsafe { *out = ptr::null_mut() };
        1
    }

    unsafe extern "C" fn successful_table(version: u32, out: *mut *mut ffi::c_void) -> i32 {
        if version != 10401 {
            return 0;
        }
        unsafe { *out = ptr::from_ref(&API).cast_mut().cast() };
        1
    }

    unsafe extern "C" fn failed_table(version: u32, out: *mut *mut ffi::c_void) -> i32 {
        unsafe { successful_table(version, out) };
        -1
    }

    #[test]
    fn status_failure_preserves_the_original_code() {
        assert_eq!(
            unsafe { query_api(failed_null) }.unwrap_err(),
            ApiLoadError::Status(0)
        );
    }

    #[test]
    fn null_success_is_rejected_before_reading_the_table() {
        assert_eq!(
            unsafe { query_api(successful_null) }.unwrap_err(),
            ApiLoadError::NullTable
        );
    }

    #[test]
    fn valid_success_copies_the_usable_table() {
        let api = unsafe { query_api(successful_table) }.unwrap();
        let (mut major, mut minor, mut patch) = (0, 0, 0);
        unsafe { api.GetAPIVersion.unwrap()(&mut major, &mut minor, &mut patch) };
        assert_eq!((major, minor, patch), (1, 4, 1));
    }

    #[test]
    fn a_nonnull_output_cannot_override_failure_status() {
        assert_eq!(
            unsafe { query_api(failed_table) }.unwrap_err(),
            ApiLoadError::Status(-1)
        );
    }
}
