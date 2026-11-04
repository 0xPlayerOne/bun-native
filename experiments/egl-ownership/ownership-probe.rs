//! Private experiment instrumentation, compiled inside the exact pinned EGL
//! module. All ownership mutations below occur in the real Inner constructor
//! and destructor; this probe only injects ABI outcomes and observes state.

use super::{EglInstance, Inner, DISPLAYS_REFERENCE_COUNT};
use alloc::{format, sync::Arc};
use std::path::Path;

const DISPLAY: usize = 0x101;
const INITIALIZE_CALLS: u32 = 0;
const INITIALIZE_SUCCESSES: u32 = 1;
const TERMINATE_CALLS: u32 = 2;
const CONTEXTS_CREATED: u32 = 3;
const CONTEXTS_DESTROYED: u32 = 4;
const PBUFFERS_CREATED: u32 = 5;
const PBUFFERS_DESTROYED: u32 = 6;
const LIVE_CONTEXTS: u32 = 7;
const LIVE_PBUFFERS: u32 = 8;

type SetFailure = unsafe extern "C" fn(i32);
type Count = unsafe extern "C" fn(u32) -> u32;

struct Fixture {
    // Keep both loads alive while any function pointer or Inner can use them.
    _control: libloading::Library,
    egl: Arc<EglInstance>,
    set_failure: SetFailure,
    count: Count,
}

impl Fixture {
    fn load(path: &Path) -> Self {
        // SAFETY: run.py builds this owned fixture from the committed C source.
        // It exports the exact EGL/control ABI and never invokes a real driver.
        unsafe {
            let control = libloading::Library::new(path).expect("load control ABI");
            let set_failure = *control.get::<SetFailure>(b"bn_fixture_fail\0").unwrap();
            let count = *control.get::<Count>(b"bn_fixture_count\0").unwrap();
            let egl = EglInstance::load_required_from_filename(path).expect("load EGL 1.4 ABI");
            Self {
                _control: control,
                egl: Arc::new(egl),
                set_failure,
                count,
            }
        }
    }

    fn count(&self, index: u32) -> u32 {
        // SAFETY: function pointer remains owned by self._control; bounded IDs.
        unsafe { (self.count)(index) }
    }

    fn create(&self, stage: i32) -> Result<Inner, crate::InstanceError> {
        // SAFETY: only the owned fake ABI receives this opaque non-null token.
        let display = unsafe { khronos_egl::Display::from_ptr(DISPLAY as *mut _) };
        // SAFETY: fixed valid stage IDs, library alive for the entire call.
        unsafe { (self.set_failure)(stage) };
        Inner::create(
            wgt::InstanceFlags::empty(),
            Arc::clone(&self.egl),
            display,
            wgt::Gles3MinorVersion::Automatic,
        )
    }

    fn snapshot(&self, phase: &str) {
        std::println!(
            "snapshot {{\"phase\":\"{phase}\",\"display_references\":{},\"initialize_calls\":{},\"initialize_successes\":{},\"terminate_calls\":{},\"contexts_created\":{},\"contexts_destroyed\":{},\"pbuffers_created\":{},\"pbuffers_destroyed\":{},\"live_contexts\":{},\"live_pbuffers\":{}}}",
            references(),
            self.count(INITIALIZE_CALLS),
            self.count(INITIALIZE_SUCCESSES),
            self.count(TERMINATE_CALLS),
            self.count(CONTEXTS_CREATED),
            self.count(CONTEXTS_DESTROYED),
            self.count(PBUFFERS_CREATED),
            self.count(PBUFFERS_DESTROYED),
            self.count(LIVE_CONTEXTS),
            self.count(LIVE_PBUFFERS),
        );
    }
}

fn references() -> usize {
    DISPLAYS_REFERENCE_COUNT
        .lock()
        .get(&DISPLAY)
        .copied()
        .unwrap_or_default()
}

fn expect_error(fixture: &Fixture, stage: i32, message: &str) {
    let error = fixture
        .create(stage)
        .expect_err("injected constructor failure");
    std::println!("constructor-error {error:?}");
    assert!(
        format!("{error:?}").contains(message),
        "original error preserved"
    );
}

/// Called only by the isolated experiment binary, with one case per process.
pub fn run_bun_native_egl_ownership_probe(path: &Path, case: &str) {
    let fixture = Fixture::load(path);
    assert_eq!(references(), 0, "fresh-process display ownership");

    let failure = match case {
        "initialize-failure" => Some((1, "failed to initialize EGL display connection")),
        "vendor-failure" => Some((2, "failed to query EGL vendor")),
        "extensions-failure" => Some((3, "failed to query EGL display extensions")),
        "config-failure" => Some((
            4,
            "unable to find an acceptable EGL framebuffer configuration",
        )),
        "client-apis-failure" => Some((5, "failed to query EGL client APIs string")),
        "bind-api-failure" | "context-failure" => Some((
            if case == "bind-api-failure" { 6 } else { 7 },
            "unable to create OpenGL or GLES 3.x context",
        )),
        "pbuffer-failure" => Some((8, "error in create_pbuffer_surface")),
        _ => None,
    };
    if let Some((stage, message)) = failure {
        expect_error(&fixture, stage, message);
        fixture.snapshot("failed-construction");
        assert_eq!(
            references(),
            0,
            "failed construction leaves no display reference"
        );
        assert_eq!(fixture.count(TERMINATE_CALLS), u32::from(stage != 1));
        assert_eq!(fixture.count(LIVE_CONTEXTS), 0, "partial context released");
        assert_eq!(fixture.count(CONTEXTS_DESTROYED), u32::from(stage == 8));
    } else {
        match case {
            "success" => {
                let owner = fixture.create(0).expect("successful constructor");
                fixture.snapshot("owned");
                assert_eq!(references(), 1);
                assert_eq!(fixture.count(LIVE_CONTEXTS), 1);
                assert_eq!(fixture.count(LIVE_PBUFFERS), 1);
                drop(owner);
                fixture.snapshot("last-owner-dropped");
                assert_eq!(references(), 0);
                assert_eq!(fixture.count(TERMINATE_CALLS), 1);
                assert_eq!(fixture.count(CONTEXTS_DESTROYED), 1);
                assert_eq!(fixture.count(LIVE_PBUFFERS), 0);
            }
            "shared-initialize-failure" | "shared-vendor-failure" => {
                let first = fixture.create(0).expect("first owner");
                let (stage, message) = if case == "shared-initialize-failure" {
                    (1, "failed to initialize EGL display connection")
                } else {
                    (2, "failed to query EGL vendor")
                };
                expect_error(&fixture, stage, message);
                fixture.snapshot("live-owner-after-failure");
                assert_eq!(references(), 1, "failed attempt preserves prior ownership");
                assert_eq!(fixture.count(TERMINATE_CALLS), 0);
                assert_eq!(fixture.count(LIVE_CONTEXTS), 1);
                let second = fixture.create(0).expect("another successful owner");
                assert_eq!(references(), 2);
                drop(first);
                fixture.snapshot("one-owner-remains");
                assert_eq!(references(), 1);
                assert_eq!(fixture.count(TERMINATE_CALLS), 0);
                assert_eq!(fixture.count(LIVE_CONTEXTS), 1);
                drop(second);
                fixture.snapshot("last-owner-dropped");
                assert_eq!(references(), 0);
                assert_eq!(fixture.count(TERMINATE_CALLS), 1);
                assert_eq!(fixture.count(CONTEXTS_DESTROYED), 2);
            }
            "shared-pbuffer-lifetime" => {
                let first = fixture.create(0).expect("first owner");
                let second = fixture.create(0).expect("second owner");
                assert_eq!(references(), 2);
                assert_eq!(fixture.count(LIVE_PBUFFERS), 2);
                drop(first);
                fixture.snapshot("one-owner-remains");
                assert_eq!(references(), 1);
                assert_eq!(fixture.count(TERMINATE_CALLS), 0);
                assert_eq!(fixture.count(LIVE_CONTEXTS), 1);
                assert_eq!(
                    fixture.count(LIVE_PBUFFERS),
                    1,
                    "dropped owner's pbuffer released"
                );
                assert_eq!(fixture.count(PBUFFERS_DESTROYED), 1);
                drop(second);
                fixture.snapshot("last-owner-dropped");
                assert_eq!(references(), 0);
                assert_eq!(fixture.count(PBUFFERS_DESTROYED), 2);
                assert_eq!(fixture.count(TERMINATE_CALLS), 1);
            }
            _ => panic!("unknown fixed case: {case}"),
        }
    }
    std::println!("case-passed {case}");
}
