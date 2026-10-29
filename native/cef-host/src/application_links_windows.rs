//! Fixed HTTPS open submission; no shell text, command parameters or chosen app.
use windows_sys::Win32::{
    System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    },
    UI::{
        Shell::{ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW},
        WindowsAndMessaging::SW_SHOWNORMAL,
    },
};
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
pub(super) fn open(url: &str) -> Result<(), String> {
    // Balance both S_OK and S_FALSE. An incompatible existing COM apartment is
    // an explicit adapter failure, never a reason to launch on another thread.
    if unsafe {
        CoInitializeEx(
            std::ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    } < 0
    {
        return Err("Native external URL COM apartment unavailable".into());
    }
    let _apartment = Apartment;
    let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    let value: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC,
        lpVerb: verb.as_ptr(),
        lpFile: value.as_ptr(),
        nShow: SW_SHOWNORMAL,
        ..Default::default()
    };
    // No SEE_MASK_NOCLOSEPROCESS, arbitrary verb, parameters, environment
    // expansion or zone-check bypass. Success means submission, not page load.
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err("Native external URL submission failed".into());
    }
    Ok(())
}
