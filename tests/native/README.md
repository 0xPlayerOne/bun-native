# Real native integration fixtures

These entry points launch the actual prebuilt GPUI host. They are separate from
the default headless `bun test tests` suite. The required Linux native CI job
builds one release host and reuses that artifact for development Bun and the
explicit inspected machine-code AOT entries below.

## Session modes

Run `scripts/quality/native-linux-session.sh` inside a dedicated Xvfb/DBus session.
Its output directory must be new, and the application command is explicit.

| Mode                   | Application command                      | Required behavior                                                                                                                                                        |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `development`          | `bun examples/native-window/main.ts`     | Public API pointer, text and Enter events; full native tree paints; OS close/relaunch; five lower-level window lifecycle cycles and the development stale-input fixture. |
| `aot`                  | Compiled `native-window`                 | The same public API pointer, text, Enter and close scenarios.                                                                                                            |
| `aot-input-race`       | Compiled `input-race`                    | A real typed input rejects an outdated replacement revision and survives an unrelated tree update.                                                                       |
| `javascript`           | `bun tests/native/javascript.js`         | A strict-JSDoc JavaScript consumer creates and updates the native tree, handles click/input callbacks, observes input revisions and releases its resources.              |
| `aot-javascript`       | Compiled `javascript`                    | The same JavaScript consumer input and cleanup scenarios through Bun AOT.                                                                                                |
| `core-lifecycle`       | `bun tests/native/public-lifecycle.ts`   | One real click starts 1,000 public subtree/listener lifecycle cycles. OS close must abort the still-active callback and clear public resource counts.                    |
| `aot-core-lifecycle`   | Compiled `core-lifecycle`                | The same public lifecycle and cancellation scenario through Bun AOT.                                                                                                     |
| `event-throughput`     | `bun tests/native/event-throughput.ts`   | Exactly 1,000 OS-delivered input edits, every sequence/revision/value checked, no input echo, final native paint and clean close.                                        |
| `aot-event-throughput` | Compiled `event-throughput`              | The same fixed input stream through Bun AOT.                                                                                                                             |
| `services`             | `bun tests/native/services.ts`           | Native default denial, allowed display read checked against the isolated X server, cancellation, stale owners, actual button input, matching paint and shutdown.         |
| `aot-services`         | Compiled `services`                      | The same native service operation and lifecycle through Bun AOT.                                                                                                         |
| `solid-services`       | `bun PACKAGE/development/application.js` | A real native display read through the shared public core from a Solid button, independent native geometry/paint checks and framework/owner cleanup.                     |
| `aot-solid-services`   | Compiled `solid-services`                | The same Solid consumer and native service operation through Bun AOT.                                                                                                    |
| `react-services`       | `bun PACKAGE/development/application.js` | The same shared public-core display operation from a React button, complete native paint and effect/listener/owner cleanup.                                              |
| `aot-react-services`   | Compiled `react-services`                | The same React consumer and native service operation through Bun AOT.                                                                                                    |
| `--`                   | An explicit benchmark command            | Create the isolated display environment for the bridge or repeated baseline runner; the supplied runner defines its own checks.                                          |

The input driver verifies that the target window belongs to the launched
application, focuses it, injects XTest input and requires matching Bun events and
complete native paint snapshots. It waits for the mounted tree before injecting
input, so an earlier empty-root paint cannot qualify as a ready fixture. Each
scenario closes the window through the window manager and checks exit and
owned-process cleanup. Screenshots are retained for inspection; there is no
automated pixel/text assertion or physical-input measurement.

## Run development fixtures

Install the pinned toolchains and Linux prerequisites from
`.github/workflows/native-linux.yml`. Framework contributors deliberately build
the native artifact once; ordinary application changes reuse it.

```sh
cargo build --locked --release -p bun-native-host
mkdir -p .bun-native
run_dir=$(mktemp -d "$PWD/.bun-native/native-suite.XXXXXX")
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
export BUN_NATIVE_HOST_PROFILE=release

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/javascript-development" javascript bun tests/native/javascript.js

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/lifecycle-development" core-lifecycle bun tests/native/public-lifecycle.ts

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/events-development" event-throughput bun tests/native/event-throughput.ts
```

The repository's strict TypeScript check enables `allowJs` and `checkJs` and
includes the JavaScript consumer. Type checking alone does not establish its
native runtime behavior; the session modes above exercise that separately.

## Compile and run AOT entries

The shared build helper's [entry table](../../experiments/aot-gpui/README.md)
covers public-core, platform, Solid and React fixtures. It records
source/configuration and executable hashes, the exact compiler command,
compiled-program metadata and target-specific JIT omission evidence.
`native-window` bundles a copy of the native host for the
distribution/baseline package. The other entries reference the existing host by
path and hash.

```sh
bun experiments/aot-gpui/build-window.ts \
  --source "$PWD" --host "$BUN_NATIVE_HOST" --host-profile release \
  --entry javascript --outdir "$run_dir/javascript-package"

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/javascript-aot" aot-javascript "$run_dir/javascript-package/javascript"

bun experiments/aot-gpui/build-window.ts \
  --source "$PWD" --host "$BUN_NATIVE_HOST" --host-profile release \
  --entry core-lifecycle --outdir "$run_dir/lifecycle-package"

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/lifecycle-aot" aot-core-lifecycle "$run_dir/lifecycle-package/core-lifecycle"

bun experiments/aot-gpui/build-window.ts \
  --source "$PWD" --host "$BUN_NATIVE_HOST" --host-profile release \
  --entry event-throughput --outdir "$run_dir/events-package"

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/events-aot" aot-event-throughput "$run_dir/events-package/event-throughput"
```

Keep each build manifest beside its corresponding native evidence. The driver
records the requested execution mode and does not independently determine
whether an arbitrary supplied executable contains Bun AOT code.

The [native services recipe](../../docs/native-services.md#reproduction-and-evidence-boundaries)
builds and executes the core, Solid and React display-service consumers in
development and AOT modes. Each uses the current explicit prebuilt protocol-6 host;
the older retained protocol-4 artifacts cannot qualify these scenarios.
The framework modes execute the exact generated production modules recorded
by `--entry solid-services` and `--entry react-services` before compiling them
to AOT. They share the core operation, policy and native implementation.

## Evidence and limits

### Shared native desktop service

The [service qualification record](evidence/services-linux-development-aot.json)
binds six actual Linux runs to the protocol-5 host, each compiler manifest,
generated framework module and native controller. Core, Solid and React all
passed development and machine-code AOT scenarios using one immutable
development-profile host. The button reads the owned GPUI window's display,
the driver independently checks the X server's 1280×800 scale-1 geometry, and
the complete native tree must paint that result before OS close. Default
denial, queued cancellation, stale/unknown ownership and shutdown are checked
by the core fixture; each framework also proves owner disposal and empty
renderer resources. The CI step repeats all six cases on its release host.

These records cover a single Xvfb screen and actual Mesa software rendering.
They do not qualify another platform, mixed-DPI monitor placement, service
performance or long-term leak freedom. The [service contract](../../docs/native-services.md)
documents backend-specific display origins and the unavailable service matrix.

### React adapter

Build each fixture with the common AOT helper before executing its two modes.
Development uses `bun PACKAGE/development/application.js`, and AOT uses
`PACKAGE/ENTRY`. The manifest fingerprints the exact generated module supplied
to the machine-code compiler, as well as its original source and configuration.
The counter, interactions, behavior and workload entries all use this recipe.
The [integrated recipe record](evidence/react-hosted-recipe-linux.json) records
26 actual local counter/event/behavior runs on the unchanged protocol4 development
host. All four entries were compiled and inspected; the unchanged workload's
execution and fixed retention observations remain a separate hosted gate.

`tests/native/react-window.py` supplies independent complete-tree expectations for
`examples/react-counter/main.tsx`, then executes the existing owned-process input
driver. Its `counter-click` scenario requires one label update, one retained keyed
move and one deletion with React row cleanup. `counter-input` requires every native
edit revision and the final input/echo values. Both require OS close and effect/
listener cleanup. The required native job runs both with development Bun and the
inspected `--entry react` AOT executable against its already-built release host.
See the [adapter instructions](../../packages/react/README.md) and
[local source-bound evidence](evidence/react-linux-development-aot.json). That local
record uses a development-profile host and does not qualify release performance.

The protocol4 follow-up uses `tests/native/react-interactions.tsx` with the common
`renderer-interactions.ts` oracle. Run `tests/native/renderer-interactions.py
--renderer React --scenario keyboard|caret|selection --mode development|aot
--output NEW_DIRECTORY -- APPLICATION` inside the existing isolated native
session. Pass the inspected `--entry react-interactions` executable in AOT mode.
The scenarios require real pointer/focus/keyboard events, both JavaScript
propagation-stop policies, caret insertion or selection replacement, exactly two
native Sets and a complete expected paint tree. Every observed registration signal
must be revoked after OS close, with all public ownership counts zero. The helper
adds no process supervisor or framework event-dispatch implementation.

The [protocol4 event record](evidence/react-events-linux-development-aot.json) binds
those six development/AOT runs and the four counter regressions to exact
protocol4 source and binary hashes. Global native sequence numbers now include
focus, pointer and key notifications; typed edit counts remain independently
checked by input revisions. The shared core validates global ordering.

`react-behavior.tsx` supplies the separate eight-case React behavior qualification.
Run `python3 tests/native/react-behavior.py --scenario SCENARIO --mode
development|aot --output NEW_DIRECTORY -- APPLICATION` inside the same isolated
session; AOT uses the inspected `--entry react-behavior` executable. Cases cover
batched state/reducer updates and hook/ref lifetime, actual boundary fallback and
recovery, a transient concurrent retry, terminal recovery-reporter/effect/ref
errors, and a non-suspending transition. The last three failure cases require an
independent survivor root to update and paint after the failed root releases its
ownership. The controller asserts exact initial/final trees and the original
driver's OS-input and child-cleanup contract. `react-behavior.json` records bounded
effect traces, ref counts, error identity assertions and final ownership. See the
[behavior and concurrency matrix](../../docs/react-behavior.md) for every scenario
and the precise transition-completion limit.

Each input scenario writes a `result.json`, bounded stdout/stderr and event logs,
before/after screenshots, renderer details and owned process-tree RSS samples.
The lifecycle fixture also writes `public-lifecycle.json` beside the event log,
with raw cycle timings, Bun memory checkpoints, weak-reference observations,
public resource counts and callback cancellation results. Weak-reference or
finite lifecycle observations alone do not establish long-term leak freedom.

### Fixed event-throughput workload

The event-throughput modes reuse the same process ownership, window discovery,
nonce freshness, native paint, deadline and cleanup checks. Ordinary smoke input
remains capped at 16 keys and 200 characters after nonce expansion. The explicit
`--event-stress` driver flag accepts only the fixed fixture title, exactly 1,000
lowercase `x` characters, no additional key/click actions, and the complete
expected initial/final native trees. It does not enable arbitrary larger input
or targeting of an existing unrelated window. The 4 MiB evidence/log bounds
remain unchanged.

The input listener uses the public API and never echoes a value or sends a
per-edit tree update. Both the application and independent driver validate all
1,000 increasing input-event sequences, contiguous input revisions and exact
prefix values. The runtime independently validates the complete contiguous UI
sequence, including key and focus events between input callbacks. The final
native paint must contain the complete value at input revision 1,000 while the
tree revision remains 1. The fixture writes `event-throughput.json` beside the
event log, with every callback observation time, inter-callback gaps, observed
queue counts and final ownership state.

The driver requests a 1 ms character delay from `xdotool` and records the actual
text-injection command interval, including subprocess and X server enqueue
overhead. The application records `performance.now()` at each callback entry.
Its observed callback rate uses the 999 intervals between the first and last
of the 1,000 callbacks. Prefix assertions and synchronous evidence appends are
part of this instrumented workload. Callback gaps include the offered input
schedule, native input processing, IPC and Bun scheduling; they are **not**
per-event dispatch latency or input-to-presentation latency. The driver and Bun
clocks are not correlated, and this fixed offered load does not establish a
maximum sustainable event rate.

The [bridge runner](../../benchmarks/BRIDGE.md) records actual native
acknowledgement timings and semantic checks. Required CI runs development and
AOT bridge measurements with instrumentation disabled; those timings are not
display-presentation measurements. The
[repeated baseline](../../benchmarks/NATIVE_BASELINE.md) compares the same
public API fixture and release host across modes, retains every trial and uses
no guessed performance budget.

The session selects Mesa software Vulkan and the input driver verifies the
adapter actually reported by GPUI. This evidence covers Linux X11/XTest and
software rendering. It does not qualify hardware-GPU performance, physical
input, display-presentation latency or macOS/Windows GUI behavior.

## Shared layout diagnostics

`tests/native/layout.ts` consumes only public core and is driven by the `layout` scenario in `scripts/quality/native-diagnostics-linux.py`. It uses the same isolated session and owned-window cleanup, with actual pointer/wheel/key/resize actions. Both development and the shared AOT helper's `--entry layout` must pass against the matching current host. The [layout contract](../../docs/native-layout.md) records exact commands, geometry bounds, source status and unsupported coverage. This diagnostic is separate from the repeated window baseline.

## Shared interaction diagnostics

`tests/native/interactions.ts` also uses public core only. The diagnostics runner's
`interactions` scenario reuses the same owned-window checks, bounded nonce-tagged
logs, deadlines and cleanup. It supplies pointer/Enter activation, Tab focus,
caret movement and Shift-selection replacement. It verifies complete
capture/target/bubble traces, distinguishes both propagation controls at the
target, and proves that native activation still occurs after JS propagation
stops. While a callback deliberately awaits a private gate, real events queue;
reparenting preserves their captured ancestry, whereas target deletion cancels
delivery and remount does not inherit old callbacks. The final complete native
paint, OS close, revoked signals and zero ownership counters are required.

Use `--entry interactions` for the corresponding AOT executable and
`--scenario interactions` with development or AOT in the existing diagnostics
runner. The [interaction contract](../../docs/native-events.md) contains exact
commands, current evidence and unsupported scope. None of these finite tests
claims DOM event compatibility, native default cancellation or full IME support.

## Portable target-host paint smoke

`tests/native/platform-smoke.ts` and `scripts/quality/native-platform-smoke.py`
exercise the real host through three public-core window/update/close lifecycles.
The controller reuses the existing bounded evidence parser and full-tree
expectations, requiring each native renderer and initial/update paint. Its
`--negative-paint-check` proves an incorrect expected native tree fails while
the fixture joins native shutdown. The shared AOT entry is `platform-smoke`.

This first macOS/Windows lane explicitly leaves OS-visible-window, real input,
screenshots and full process-tree observation unverified. A successful portable
paint test is not those claims. See [native platform qualification](../../docs/native-platforms.md)
for target requirements, artifact scope and remaining #246/#256 work.
