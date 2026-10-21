# M3 native platform acceptance

Explicit functional qualification without changing shipping deadlines or sandbox policy.

**Scope:** M3 #13 Windows and #14 Linux after merged #80.
**Status:** Linux #14 has completed the declared Debian 12 / X11 functional acceptance below. Windows #13 remains open pending actual native execution; cross-compilation is not acceptance.

## Deadline profiles

The normal native startup/request/browser-close/backend-exit deadlines remain
10 seconds, 10 seconds, 8 seconds and 2 seconds. They do not automatically change
when a startup fails or when a virtual machine is detected.

A private runtime configuration can explicitly select
`qualification_profile: "emulated-functional"`. This finite functional-test profile
uses 60/30/30/5 seconds respectively. Native readiness binds the request deadline
to that profile; arbitrary or contradictory deadline values are rejected.
Successful smoke records must attest the selected profile in native diagnostics.

The profile changes no security policy, sandbox flag, frame authority, workload,
cycle count or cleanup criterion. All timeouts remain failures. The production
signed-cache validator still rejects any qualification-profile field, including
one in an otherwise valid signed artifact. A qualification copy is not a shipping
artifact and cannot be silently promoted into the production cache.

`qualify-cef-prebuilt.ts` and `qualify-cef-development.ts` accept an explicit
`--emulated-functional` argument; the fault runner accepts the same named flag.
Process observation is bounded to five minutes per invocation in that profile.
The public page deadline is one minute. There is no retry with a slower profile
or an alternate browser after failure.

## Readiness correction

Development and fault page timers start only after native view creation returns,
while their listeners are installed before creation. This separates native creation
from page readiness without missing early completion events.

The public packaged-page fixture now waits for the actual `connect-src` and
`frame-src` CSP violation events for its blocked origin. A fixed 100 ms sleep was
not proof that those asynchronous events had arrived. Missing, duplicate or
unrelated violations cannot pass; the observation has its own finite deadline,
removes its listeners on every outcome, and leaves the actual CSP unchanged.

## Evidence boundaries

An emulated-functional run proves only the reported native OS/application
functionality with that explicit timing profile. It is not a standard-deadline
startup pass, a native-hardware performance result, a physical input/DPI test,
or proof of hardware GPU acceleration. Preserve failed standard-profile results
and initial prerequisite failures alongside any later qualified executions.

All work uses private benchmark VMs and contributor-built native artifacts.
Consumers run prebuilt executables and bundled Bun; they never compile Rust as
part of the smoke script. No hosted Actions job is dispatched and the billing
pause remains in effect.

## Executed Linux closeout

The declared Linux profile is **Debian 12 x64, glibc 2.36, X11/Xvfb, an
unprivileged application user, and Chromium's namespace/seccomp isolation**. It
ran as a real x86-64 Linux guest under QEMU TCG on the arm64 development Mac.
The `emulated-functional` profile was selected explicitly. These results do not
qualify standard-deadline startup, native-CPU performance, native Wayland,
hardware acceleration, physical keyboard/IME/DPI behavior, or other distributions.

The native prebuild and prebuilt/development drivers were built/executed from
`6dac2aac822b0b135d1ab38ac7cbc83540ee2d80`. Their source is unchanged in
`c1da5d2bba69fd0c73f43146574ed91082b1e06c`, which supplies the executed fault
helper-selection and acknowledgement fixes. Guest source hashes were independently
compared with the committed Git objects and current checkout. No cross-compile
result is substituted for executing the guest application.

| Acceptance                   | Executed evidence                                                                                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prebuilt consumer matrix     | All 12 cases passed: three installed launches, last-window exit, three unsafe-switch rejections, wrong version, missing Bun, missing X11 display, missing CEF library, and restored installation.                                                                                      |
| Compiler independence        | Positive launches use an empty compiler PATH, an unrelated working directory, and an installation path with spaces and non-ASCII characters. The original artifact remains unchanged.                                                                                                  |
| Resource lifecycle           | Five successful packaged runs execute 100 total create/close cycles, multiple windows/child views, resize/show/hide/focus API calls, navigation/document changes, callback detachment, stale-handle rejection and final resource convergence. Physical input behavior is not inferred. |
| Native shutdown              | Every accepted run has its expected exit status, unforced backend exit where applicable, explicit host shutdown acknowledgement, no timeout, and no observed orphan or cleanup survivor.                                                                                               |
| Development-origin isolation | The real allowed origin and redirect load successfully. The forbidden server receives zero requests from the tested redirects, subframes, scripts and fetches.                                                                                                                         |
| Process faults               | Backend exit, backend exit with a pipe-retaining descendant, renderer termination, and GPU termination/recovery all passed. A fresh private receipt binds GPU recovery to an actual injected termination.                                                                              |
| Browser isolation            | Positive runs retain native seccomp, no-new-privileges, zero-effective-capability and PID-namespace observations for isolated descendants. These are sampled observations, not continuous attestation of every helper.                                                                 |
| Browser/runtime identity     | Actual exported CEF 154.0.34 / Chromium 154.0.8037.98, commit 3633; bundled Bun 1.4.3. The binary-version probe does not itself establish sandbox state.                                                                                                                               |

Linux CEF's forked children can retain `--type=zygote` in their argument vector.
The fault fixture now distinguishes the pinned renderer/GPU thread signatures
without choosing a zygote broker by its name. It still requires the exact private
executable subtree, current owner/descendant relationship, PID creation identity
and fresh fixture readiness before terminating one test helper. Ambiguous or
partial signatures fail closed. This diagnostic rule is not production authority
or a general process-discovery API.

The earlier attempt that overlapped another emulated guest timed out. Its raw
failure is preserved as `overlap-timeout.json.gz`, not rewritten as successful.
The successful prebuilt matrix used the same explicit finite profile. No
`--no-sandbox`, privileged container, seccomp removal, or slower automatic retry
was introduced. The production runtime/cache still rejects qualification-profile
fields in release artifacts.

### Evidence and reproduction

`evidence/m3-linux/manifest.json` records five acceptance report collections, the
prior failed attempt, original/redacted/stored hashes, native binary hashes, and
execution-source identities. Source and runtime observations are retained even
when their versions differ from the later evidence-only commit. Private paths
and expired fixture credentials are redacted; outcomes, timings, process counts,
security observations and source hashes are unchanged.

Replay the preserved evidence without launching a browser:

```sh
python scripts/report_m3_platform.py evidence/m3-linux
```

The replay requires the exact positive/negative trial matrix, 20 lifecycle cycles
per successful packaged run, complete development-origin isolation, all four
actual faults, matching binary versions, sampled OS isolation and verified
cleanup. Unit tests distinguish this replay from fresh native execution.

On a prepared supported unprivileged Linux guest, the native qualification
commands remain:

```sh
export PYTHON=/absolute/venv/bin/python
export BUNLY_BENCH_SANDBOX=1
xvfb-run -a dbus-run-session -- bun scripts/qualify-cef-prebuilt.ts /absolute/runtime/bunly_host --emulated-functional
xvfb-run -a dbus-run-session -- bun scripts/qualify-cef-development.ts /absolute/runtime/bunly_host --emulated-functional
xvfb-run -a dbus-run-session -- "$PYTHON" scripts/qualify-cef-faults.py /absolute/runtime/bunly_host --bun /absolute/bun-1.4.3 --emulated-functional
```

Use the standard profile by omitting the flag on suitable native hardware;
results must attest the profile actually selected. The source prebuild is never
modified to make a failed setup appear to pass. Xvfb is a virtual display, not
hardware-input or acceleration qualification. Required native libraries, X11,
user namespaces and available Chromium sandbox support are prerequisites rather
than capabilities to disable after a failure.

## Remaining Windows boundary

The Windows x64 contributor-built bootstrap, application DLL, pinned CEF and Bun
artifacts, strict token/job observer, and executable platform runners exist.
The evaluation guest has not completed a standard-user native acceptance run.
It remains at first-run setup; credential entry was blocked by the available
execution tooling during this continuation and was not bypassed.

**#13 remains open.** Actual Windows prebuilt launches, runtime sandbox/token/job
observations, failure recovery and clean process-tree exit are still required.
No Linux result, portable test, or Windows cross-compilation closes that gap.
M3 therefore remains open with Windows as its only outstanding platform issue
once the Linux closeout lands.

## Closeout validation

The complete macOS checkout passes `bun run check` with **465 tests and 6,588
assertions across 52 files**, browser-only typechecking, compiler-free SDK builds,
and **139 Python tests**. Native CEF library tests pass **43 cases**, with packaging
Clippy (`-D warnings`) and Rust formatting also passing under Rust 1.91.0.
The Linux evidence replay and the existing macOS evidence replay both pass;
replaying evidence is not relabeled as a new native execution. Normal formatting,
lint and pre-commit checks remain enabled.

`CI_BILLING_PAUSED` remains true. No hosted workflow was dispatched, no production
credential was used, and no dependency, SDK/native runtime, public release or Adea
configuration was changed by the evidence closeout. The fault-fixture and replay
changes in PR #82 are contributor testing code, not additional application-runtime
payloads. #14 can close on merge of that tested implementation and evidence;
#13 and the M3 milestone must remain open.
