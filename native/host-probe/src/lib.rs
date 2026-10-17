//! M1 qualification fixture, NOT the CEF host. No third-party native dependencies.
use std::sync::{mpsc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
mod napi;
const STOP: u32 = u32::MAX;
static RUNNING: AtomicBool = AtomicBool::new(false);
static CALLBACK: AtomicUsize = AtomicUsize::new(0);
static OWNER: OnceLock<std::thread::ThreadId> = OnceLock::new();
struct Queue { tx: mpsc::SyncSender<u32>, rx: Mutex<mpsc::Receiver<u32>> }
fn queue() -> &'static Queue {
    static Q: OnceLock<Queue> = OnceLock::new();
    Q.get_or_init(|| { let (tx, rx) = mpsc::sync_channel(64); Queue {tx, rx: Mutex::new(rx)} })
}
#[no_mangle]
pub extern "C" fn bunly_probe_abi() -> u32 { 1 }
#[no_mangle]
pub extern "C" fn bunly_probe_mark_main() -> i32 {
    #[cfg(target_os="macos")]
    { extern "C" { fn pthread_main_np() -> i32; }
      if unsafe { pthread_main_np() } != 1 { return -5; } }
    match OWNER.set(std::thread::current().id()) { Ok(()) => 0, Err(_) => -2 }
}
#[no_mangle]
pub extern "C" fn bunly_probe_add(a:u32,b:u32) -> u32 { a.wrapping_add(b) }
/// Caller must provide a valid readable buffer for `len` bytes, alive for the call.
#[no_mangle]
pub unsafe extern "C" fn bunly_probe_checksum(data:*const u8,len:usize) -> u32 {
    if len>1024*1024 || (len>0 && data.is_null()) { return u32::MAX; }
    let bytes=if len==0 { &[][..] } else { std::slice::from_raw_parts(data,len) };
    bytes.iter().fold(2_166_136_261u32,|h,b| (h ^ *b as u32).wrapping_mul(16_777_619))
}
/// Callback must outlive `run`. Clear only after the native loop returns.
#[no_mangle]
pub extern "C" fn bunly_probe_callback(callback:Option<extern "C" fn(u32)>) -> i32 {
    if let Some(callback) = callback {
        match CALLBACK.compare_exchange(0, callback as usize, Ordering::AcqRel, Ordering::Acquire) { Ok(_) => 0, Err(_) => -2 }
    } else {
        if RUNNING.load(Ordering::Acquire) { return -2; }
        CALLBACK.store(0, Ordering::Release); 0
    }
}
#[no_mangle]
pub extern "C" fn bunly_probe_post(value:u32) -> i32 {
    if value==STOP {return -4;}
    match queue().tx.try_send(value) { Ok(())=>0, Err(_)=>-3 }
}
#[no_mangle]
pub extern "C" fn bunly_probe_stop() -> i32 { match queue().tx.try_send(STOP) {Ok(())=>0,Err(_)=>-3} }
#[no_mangle]
pub extern "C" fn bunly_probe_post_from_thread(value:u32) -> i32 {
    std::thread::spawn(move||bunly_probe_post(value)).join().unwrap_or(-6)
}
/// Runs a bounded, notification-driven native loop. It intentionally blocks the caller.
/// This proves thread handoff, not AppKit/CEF integration or GUI responsiveness.
#[no_mangle]
pub extern "C" fn bunly_probe_run(timeout_ms:u32) -> i32 {
    if OWNER.get()!=Some(&std::thread::current().id()) {return -5;}
    if RUNNING.swap(true,Ordering::AcqRel) {return -2;}
    let deadline=Instant::now()+Duration::from_millis(timeout_ms.min(30_000) as u64);
    let result=(|| {
        let receiver=match queue().rx.lock() {Ok(r)=>r,Err(_)=>return -6};
        loop {
            let Some(remaining)=deadline.checked_duration_since(Instant::now()) else {return -1;};
            let value=match receiver.recv_timeout(remaining) {Ok(v)=>v,Err(_)=>return -1};
            if value==STOP {return 0;}
            let callback=CALLBACK.load(Ordering::Acquire);
            if callback!=0 {
                let callback:extern "C" fn(u32)=unsafe{std::mem::transmute(callback)};
                callback(value);
            } else if napi::dispatch(value)!=0 {return -7;}
        }
    })();
    RUNNING.store(false,Ordering::Release);result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn abi_and_integer_contract() { assert_eq!(bunly_probe_abi(),1);assert_eq!(bunly_probe_add(u32::MAX,2),1); }
    #[test] fn checksum_bounds() {unsafe{
        assert_eq!(bunly_probe_checksum(std::ptr::null(),0),2_166_136_261);
        assert_eq!(bunly_probe_checksum(std::ptr::null(),1),u32::MAX);
        assert_ne!(bunly_probe_checksum(b"abc".as_ptr(),3),u32::MAX);
    }}
    #[test] fn bounded_queue() {let(tx,rx)=mpsc::sync_channel(1);assert!(tx.try_send(1).is_ok());assert!(tx.try_send(2).is_err());assert_eq!(rx.recv().unwrap(),1);}
}
