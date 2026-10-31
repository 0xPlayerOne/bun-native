# React behavior qualification

This is the behavior contract for [BN3 #235](https://github.com/0xPlayerOne/bun-native/issues/235).
The adapter pins React **19.3.1**, `react-reconciler` **0.34.0** and reconciler
declarations **0.34.1**. It renders through the same public core, staged renderer,
protocol4 contract and GPUI host as Solid. These tests introduce no alternate
native widget or event implementation.

## Native scenario matrix

[`react-behavior.tsx`](../tests/native/react-behavior.tsx) asserts React behavior
and resource ownership. The independent
[`react-behavior.py`](../tests/native/react-behavior.py) controller uses the common
owned-process X11 driver to require an initial full native tree, an actual OS
click, an application qualification event, the final full native tree,
screenshots and clean OS close. Each case runs in development and inspected AOT.

| Scenario            | Required behavior                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lifecycle`         | One actual click performs two functional state updates and two reducer dispatches. Context and memoized output produce `State 2 / Reducer 2`, with one native label Set and no intermediate committed value1. The `useRef` identity and object/callback native refs survive the update. Layout and passive effects clean their previous value before setting up the next, then clean once on OS close. |
| `boundary-fallback` | A healthy mounted child throws its original render error after a real click. `componentDidCatch` receives that same object once. The child ref and effects release, the original root remains live, and its native fallback is painted.                                                                                                                                                                |
| `boundary-recovery` | An initially failed child produces an actual native fallback before input. Its abandoned render runs no committed effects or native ref attachment. The real click resets the boundary and updates state; the healthy child mounts, effects run and `Healthy 1` paints.                                                                                                                                |
| `recoverable-retry` | A real click starts an ordinary-priority update outside the discrete callback. One attempt throws; React retries successfully and reports the original cause once through frozen error information. A subsequent ordinary state update paints `State 2`; the root remains usable.                                                                                                                      |
| `throwing-reporter` | The transient retry succeeds but the optional recovery reporter throws. `flush()` and `closed` reject with the exact reporter error. Failed-root refs, effects, nodes and callbacks release. An independent root then updates and paints in the same still-open native window.                                                                                                                         |
| `cleanup-effect`    | Explicit disposal runs a passive-effect cleanup that throws. `dispose()` and `closed` reject with that exact error after native ownership is released. The independently mounted survivor still updates and paints.                                                                                                                                                                                    |
| `cleanup-ref`       | The React19 callback-ref cleanup throws during explicit disposal. The same exact-error and independent-survivor assertions apply; remaining effect and object-ref cleanup still runs once.                                                                                                                                                                                                             |
| `transition`        | A real click starts a non-suspending `useTransition` update. The test separately waits for its committed layout effect, then awaits native acknowledgement and requires the final native tree. The last committed pending state must be false. The outcome observed at an earlier ordinary `flush()` is recorded, without requiring that barrier to drain transition work.                             |

All cases require zero public ownership counts after application shutdown. The
three terminal cases additionally require only the window root and the two-node
survivor subtree to remain before OS close. Their final native snapshot must
exclude every node from the failed root. A terminal reporter may interrupt a
retry before or after its staged Set reaches GPUI, so the controller records the
actual final tree revision without inventing an exact intermediate batch count.

The eight scenarios complement the already separate
[native interaction qualification](../tests/native/evidence/react-events-linux-development-aot.json):
capture/target/bubble routing, retained callback lifetime, pointer/key/focus events,
Enter activation, caret insertion and selection replacement. An input event
updates observed framework state without echoing native text or advancing its
native edit revision.

## Scheduling and concurrency limits

| Operation                                                                | Supported completion boundary                                                                                                                                                                                               | What this does not establish                                                                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial `render`                                                         | The initial React JavaScript commit finishes before `ready` can resolve the corresponding native acknowledgement. The native fixture separately checks the complete painted tree.                                           | A JavaScript effect or an acknowledgement is not display presentation.                                                                                                      |
| `root.render(next)`                                                      | A synchronous root update followed by the adapter's ordinary commit barrier and shared native flush.                                                                                                                        | It does not wait for application work scheduled after that barrier.                                                                                                         |
| Synchronous native event callback                                        | The adapter assigns discrete event priority. The lifecycle fixture requires its four state/reducer operations to produce one native label Set.                                                                              | Native event propagation remains owned by the public core; React does not redispatch the path.                                                                              |
| Ordinary state update outside an event                                   | The concurrent root schedules ordinary work; `flush()` waits for its already-scheduled normal-priority commit and native acknowledgement. The retry fixture exercises React's successful synchronous recovery.              | No claim of starvation freedom or interruption timing under arbitrary competing work.                                                                                       |
| Non-suspending `useTransition`                                           | The transition can commit through the pinned reconciler. Applications that need its resulting native state must observe its own completion and then flush. The fixture uses a committed layout effect for that observation. | An ordinary `flush()` is not a general transition-drain API. No animation, display-priority, preemption or presentation guarantee.                                          |
| Layout and passive effects                                               | These follow the JavaScript commit. Tests require per-value setup/cleanup balance and ref release.                                                                                                                          | Effects cannot infer native geometry or visible presentation from their own execution.                                                                                      |
| Asynchronous event continuation                                          | Subsequent updates use ordinary React scheduling after the synchronous discrete wrapper returns.                                                                                                                            | The adapter does not keep an unbounded async discrete-event context. General async actions, `useOptimistic` and action-state behavior are not qualified by these scenarios. |
| Suspense/Activity hidden host subtrees                                   | Unsupported hiding/unhiding hooks fail explicitly; source tests check cleanup.                                                                                                                                              | Suspended transitions, reveal ordering, streaming/hydration and hidden retained-tree semantics are not implemented.                                                         |
| View-transition animations                                               | Native animation-instance/name/start callbacks fail explicitly. A source regression checks rejected native view-transition refs and cleanup.                                                                                | React scheduling transitions are separate from this unsupported animation API.                                                                                              |
| Portals, hydration, host forms, fragment refs and presentation callbacks | Outside the implemented native adapter contract.                                                                                                                                                                            | DOM semantics and browser libraries are not provided.                                                                                                                       |

The adapter's pending ordinary commit-barrier queue is bounded at 128. Native
failure or root disposal rejects outstanding barriers and revokes only that
root's registrations. The existing source suites also exercise disposal requested
from layout effects, disposal before the first acknowledgement, callback failures
and asynchronous native rejection. Their subprocess peers are headless; they do
not replace the actual GPUI scenarios above.

### Transition correction

The original native transition scenario failed on the real GPUI host. The pinned
reconciler's `completeRootWhenReady` invokes `suspendOnActiveViewTransition` for
ordinary transition-eligible lanes even when no `ViewTransition` component is
present. The adapter had treated that scheduling hook as an animation request and
thrown `UnsupportedFeatureError`, preventing the update from committing.

The hook now returns normally because this host has no active view-transition
animation to await. Native animation-specific entry points remain unsupported.
This follows the exact installed 0.34.0 development and production reconciler
call sites and the pinned 0.34.1 hook declaration; it adds no scheduler or hidden
native queue. The source regression and the previously failing native scenario
exercise the correction. The initial failed evidence is retained separately.

## Reproduce development and AOT

Supply a real prebuilt host that matches the checked-out protocol, and declare its
actual profile. The example below uses a release build; a local development host
must be labelled `dev` in both the environment and AOT manifest.

```sh
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
export BUN_NATIVE_HOST_PROFILE=release
mkdir -p .bun-native
run_dir=$(mktemp -d "$PWD/.bun-native/react-behavior.XXXXXX")

bun experiments/aot-gpui/build-window.ts --source "$PWD" \
  --host "$BUN_NATIVE_HOST" --host-profile release --entry react-behavior \
  --outdir "$run_dir/aot-package"

for mode in development aot; do
  command=(bun "$run_dir/aot-package/development/application.js")
  if [[ "$mode" == aot ]]; then
    command=("$run_dir/aot-package/react-behavior")
  fi
  for scenario in lifecycle boundary-fallback boundary-recovery recoverable-retry throwing-reporter cleanup-effect cleanup-ref transition; do
    evidence="$run_dir/$mode-$scenario"
    xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
      dbus-run-session -- bash scripts/quality/native-linux-session.sh \
      "$evidence-session" -- python3 tests/native/react-behavior.py \
      --scenario "$scenario" --mode "$mode" --output "$evidence" -- "${command[@]}"
  done
done
```

The compiler helper fingerprints the React adapter, shared renderer, core,
protocol, runtime, fixture, native source and build configuration. Both modes
consume the same fingerprinted generated development module; the compiler takes
that module as its input and verifies actual compiled-program metadata and JIT
range removal. The controller's
`--mode aot` label alone provides neither check. The existing required Linux
native lane builds its release host once and runs these 16 cases against that
same host, retaining each controller report, application assertion summary,
event log, screenshots and compiler manifest.
The generated module selects production React/reconciler for both runtime modes.
This keeps framework behavior matched while changing development Bun execution
to the actual machine-code AOT path.

## Evidence scope

The [integrated generated-module record](../tests/native/evidence/react-hosted-recipe-linux.json)
adds all 16 behavior cases under the current build recipe, plus ten counter and
event regressions. The same generated module ran through development Bun and
supplied the corresponding AOT compilation input. All 26 runs passed with stable
source/artifact hashes, complete expected native trees and normal process cleanup
on the unchanged protocol4 development host. Both transition runs again observed
ordinary flush before the explicit transition commit. This is local correctness
evidence; the required hosted job repeats it with its release host.

The [original source-bound local record](../tests/native/evidence/react-behavior-linux-development-aot.json)
contains all 16 passing cases on the same protocol4 development-profile host:
eight development launches and eight launches of the inspected AOT executable.
All exited normally, with no forced termination, surviving or unreaped observed
child processes, and zero final public ownership counts. The AOT executable is
72,924,200 bytes, SHA-256
`6e311eb9d89fe4dedf7d95dc300efe53617ae5f20e401b78bddcb7ca63c37321`;
its manifest records a compiled program and 27 removed JIT ranges. The record
binds 72 source/harness files, validates 27 native/toolchain files against the
previous qualified host evidence, and retains raw report/image/log hashes.

Both transition runs observed the ordinary flush return while the committed
value was still zero. Their pending snapshots were `false, true, false`, followed
by the required native value1 paint. These observations demonstrate why the
fixture separately awaits the transition commit; they are not a promise that
every future scheduling interleaving returns the same intermediate result.

The record also retains the original transition-hook failure and two earlier
execution failures: a completed input/paint run that missed OS-close completion,
and a native-open timeout before React mounted. An unchanged published
interaction fixture passed during the investigation. Their cause remains
unproven; no timeout or assertion was relaxed. All final cases were run once per
mode after the concrete transition correction, with unchanged source hashes.

Local qualification records must bind every result to the exact source and
application/host hashes. The original record used direct TSX development launches
and direct-source AOT compilation; its fingerprints are preserved as historical
evidence rather than reassigned to the generated-module recipe above. Linux X11
uses actual GPUI with XTest input and a Mesa
software Vulkan adapter; it does not qualify physical input, hardware-GPU
performance, display presentation, IME, accessibility, or macOS/Windows behavior.
Independent hosted release-profile qualification remains a required gate.

This behavior work does not close the matched direct-core/Solid/React performance
comparison or [shared retention investigation #287](https://github.com/0xPlayerOne/bun-native/issues/287).
Public zero-ownership assertions and sampled reference observations are not proof
that the whole managed or native heap is empty.
