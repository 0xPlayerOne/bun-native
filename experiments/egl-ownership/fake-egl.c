/* Deterministic EGL 1.4 ABI fixture for the private pinned-WGPU experiment.
 * No driver, window, or display-server calls. Unexpected entry points abort.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef void *Display;
typedef void *Config;
typedef void *Context;
typedef void *Surface;
typedef unsigned int Boolean;
typedef unsigned int Enum;
typedef void (*Proc)(void);

enum {
    INITIALIZE_CALLS,
    INITIALIZE_SUCCESSES,
    TERMINATE_CALLS,
    CONTEXTS_CREATED,
    CONTEXTS_DESTROYED,
    PBUFFERS_CREATED,
    PBUFFERS_DESTROYED,
    LIVE_CONTEXTS,
    LIVE_PBUFFERS,
    COUNTER_COUNT
};

static int failure_stage;
static int last_error = 0x3000;
static unsigned int counters[COUNTER_COUNT];
static unsigned char contexts[16];
static unsigned char pbuffers[16];

static _Noreturn void unexpected(const char *name) {
    fprintf(stderr, "unscripted EGL fixture call or invalid argument: %s\n", name);
    abort();
}

static void event(const char *name) {
    printf("egl-call %s\n", name);
    fflush(stdout);
}

static void check_display(Display display) {
    if ((uintptr_t)display != 0x101) unexpected("display identity");
}

void bn_fixture_fail(int stage) {
    if (stage < 0 || stage > 8) unexpected("failure stage");
    failure_stage = stage;
}

unsigned int bn_fixture_count(unsigned int index) {
    if (index >= COUNTER_COUNT) unexpected("counter index");
    return counters[index];
}

Boolean eglInitialize(Display display, int *major, int *minor) {
    check_display(display);
    event("initialize");
    counters[INITIALIZE_CALLS]++;
    if (failure_stage == 1) {
        last_error = 0x3001;
        return 0;
    }
    *major = 1;
    *minor = 4;
    counters[INITIALIZE_SUCCESSES]++;
    return 1;
}

const char *eglQueryString(Display display, int name) {
    check_display(display);
    if (name == 0x3053) {
        event("query-vendor");
        if (failure_stage != 2) return "Bun Native isolated EGL fixture";
    } else if (name == 0x3055) {
        event("query-extensions");
        if (failure_stage != 3) return "";
    } else if (name == 0x308D) {
        event("query-client-apis");
        if (failure_stage != 5) return "OpenGL_ES";
    } else {
        unexpected("query-string name");
    }
    last_error = 0x3008;
    return NULL;
}

Boolean eglChooseConfig(Display display, const int *attributes, Config *configs,
                        int config_size, int *count) {
    check_display(display);
    if (!attributes || config_size != 1 || !configs || !count)
        unexpected("choose-config arguments");
    event("choose-config");
    *count = failure_stage == 4 ? 0 : 1;
    if (*count) configs[0] = (Config)(uintptr_t)0x102;
    return 1;
}

Boolean eglBindAPI(Enum api) {
    if (api != 0x30A0) unexpected("bind-api");
    event("bind-api");
    if (failure_stage == 6) {
        last_error = 0x3003;
        return 0;
    }
    return 1;
}

Context eglCreateContext(Display display, Config config, Context share,
                         const int *attributes) {
    check_display(display);
    if ((uintptr_t)config != 0x102 || share || !attributes)
        unexpected("create-context arguments");
    event("create-context");
    if (failure_stage == 7) {
        last_error = 0x3003;
        return NULL;
    }
    unsigned int index = counters[CONTEXTS_CREATED]++;
    if (index >= 16) unexpected("context limit");
    contexts[index] = 1;
    counters[LIVE_CONTEXTS]++;
    return (Context)(uintptr_t)(0x200 + index);
}

Surface eglCreatePbufferSurface(Display display, Config config,
                               const int *attributes) {
    check_display(display);
    if ((uintptr_t)config != 0x102 || !attributes)
        unexpected("create-pbuffer arguments");
    event("create-pbuffer");
    if (failure_stage == 8) {
        last_error = 0x3003;
        return NULL;
    }
    unsigned int index = counters[PBUFFERS_CREATED]++;
    if (index >= 16) unexpected("pbuffer limit");
    pbuffers[index] = 1;
    counters[LIVE_PBUFFERS]++;
    return (Surface)(uintptr_t)(0x300 + index);
}

Boolean eglDestroyContext(Display display, Context context) {
    check_display(display);
    uintptr_t index = (uintptr_t)context - 0x200;
    if (index >= 16 || !contexts[index]) unexpected("destroy-context identity");
    event("destroy-context");
    contexts[index] = 0;
    counters[CONTEXTS_DESTROYED]++;
    counters[LIVE_CONTEXTS]--;
    return 1;
}

Boolean eglDestroySurface(Display display, Surface surface) {
    check_display(display);
    uintptr_t index = (uintptr_t)surface - 0x300;
    if (index >= 16 || !pbuffers[index]) unexpected("destroy-pbuffer identity");
    event("destroy-pbuffer");
    pbuffers[index] = 0;
    counters[PBUFFERS_DESTROYED]++;
    counters[LIVE_PBUFFERS]--;
    return 1;
}

Boolean eglTerminate(Display display) {
    check_display(display);
    if (counters[LIVE_CONTEXTS]) unexpected("terminate before context destruction");
    event("terminate");
    counters[TERMINATE_CALLS]++;
    /* EGL termination releases remaining unbound display resources. This does
     * not hide the shared-owner check taken before the last display release. */
    for (unsigned int index = 0; index < 16; index++) pbuffers[index] = 0;
    counters[LIVE_PBUFFERS] = 0;
    return 1;
}

int eglGetError(void) {
    int error = last_error;
    last_error = 0x3000;
    return error;
}

/* The loader requires these EGL 1.0–1.4 exports. They are not used by the
 * constructor/drop paths under test; accidentally reaching one is a failure. */
#define UNSCRIPTED(result, name, arguments) \
    result name arguments { unexpected(#name); }

UNSCRIPTED(Boolean, eglCopyBuffers, (Display d, Surface s, void *p))
UNSCRIPTED(Surface, eglCreatePixmapSurface, (Display d, Config c, void *p, const int *a))
UNSCRIPTED(Surface, eglCreateWindowSurface, (Display d, Config c, void *w, const int *a))
UNSCRIPTED(Boolean, eglGetConfigAttrib, (Display d, Config c, int a, int *v))
UNSCRIPTED(Boolean, eglGetConfigs, (Display d, Config *c, int size, int *n))
UNSCRIPTED(Display, eglGetCurrentDisplay, (void))
UNSCRIPTED(Surface, eglGetCurrentSurface, (int kind))
UNSCRIPTED(Display, eglGetDisplay, (void *native))
UNSCRIPTED(Proc, eglGetProcAddress, (const char *name))
UNSCRIPTED(Boolean, eglMakeCurrent, (Display d, Surface draw, Surface read, Context c))
UNSCRIPTED(Boolean, eglQueryContext, (Display d, Context c, int a, int *v))
UNSCRIPTED(Boolean, eglQuerySurface, (Display d, Surface s, int a, int *v))
UNSCRIPTED(Boolean, eglSwapBuffers, (Display d, Surface s))
UNSCRIPTED(Boolean, eglWaitGL, (void))
UNSCRIPTED(Boolean, eglWaitNative, (int engine))
UNSCRIPTED(Boolean, eglBindTexImage, (Display d, Surface s, int buffer))
UNSCRIPTED(Boolean, eglReleaseTexImage, (Display d, Surface s, int buffer))
UNSCRIPTED(Boolean, eglSurfaceAttrib, (Display d, Surface s, int a, int v))
UNSCRIPTED(Boolean, eglSwapInterval, (Display d, int interval))
UNSCRIPTED(Enum, eglQueryAPI, (void))
UNSCRIPTED(Surface, eglCreatePbufferFromClientBuffer, (Display d, Enum t, void *b, Config c, const int *a))
UNSCRIPTED(Boolean, eglReleaseThread, (void))
UNSCRIPTED(Boolean, eglWaitClient, (void))
UNSCRIPTED(Context, eglGetCurrentContext, (void))
