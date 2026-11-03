# BN2 initial Solid integration

This is an implementation-in-progress record for [#231](https://github.com/0xPlayerOne/bun-native/issues/231) and [#234](https://github.com/0xPlayerOne/bun-native/issues/234), using merged [BN1 #271](https://github.com/0xPlayerOne/bun-native/pull/271) and the shared protocol-4 native interaction increment. It does not close BN2 or claim framework-wide/platform release support. Earlier sections retain historical source/artifact observations; the protocol-4 qualification below identifies the newer implementation separately.

## Implemented route

`examples/solid-counter/main.tsx` uses ordinary Solid signals, an effect, `<For>` keyed rows, cleanup hooks, native button events and native input observations. The pinned official Solid universal JSX transform targets `@bun-native/solid`. The adapter stages synchronous framework mutations and commits them through the existing public core's asynchronous atomic batches. The unchanged GPUI host owns native widgets and the main UI thread.

The initial renderer API and lifecycle/error semantics are documented in [the package README](../packages/solid/README.md). The current adapter delegates staged nodes, keyed native planning, commit scheduling, listener reconciliation, revision-aware input intents and window lifetime to the internal `@bun-native/renderer` package, also consumed by the developing React adapter. Solid retains its universal-renderer, owner and signal integration. This change adds no alternative Rust host or framework-specific widget implementation.

## Exact initial environment

| Item               | Value                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Source base        | `cc27ec705c1f90db35ed5f7182c41abc5e68f821`; first observations ran from a dirty isolated `feat/bn2-solid` worktree |
| Solid              | `1.9.18`; official `babel-preset-solid` `1.9.16`, Babel `7.29.7`                                                   |
| Bun                | `1.4.4-canary.1+da867c60b`, full revision `da867c60bf0bcbf9d6d36994f8ca0efa42075115`                               |
| Rust / GPUI        | Existing Rust `1.98.1` development-profile host; GPUI `0.2.2`, Zed `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d`      |
| Native host        | 110,849,576 bytes; SHA-256 `8a221ff318aa0a3ee0bfff95bc243dc0091d3c0a2af97347ab3bc550cc3ad40e`                      |
| Display/input      | Linux x86_64, isolated Xvfb X11/Openbox and actual XTest pointer/text input                                        |
| Actual GPU adapter | Software llvmpipe LLVM 20.1.2; Mesa `25.2.8-0ubuntu0.24.04.4`                                                      |
| AOT executable     | 71,253,032 bytes; SHA-256 `3759597a3c9d15d3de9439745652bd52038b2c2fff5cd385d6930fcf44761038`                       |
| AOT inspection     | Valid compiled-program flag (`0x417c`), JIT unused with 27 removed JIT ranges; interpreter present                 |

No Rust rebuild or native-binary copy was needed. The development host remains an explicitly unoptimized diagnostic host; these bytes are not a release-size baseline. The AOT build used `bun compile --no-script --production --explain=json` on the same generated JavaScript module run in development, followed by the existing compiled-program and runtime-feature inspectors.

## First published renderer evidence

| Check                                              | Actual result                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict source checks                               | 42 TypeScript/TSX files pass; workspace lint, package boundaries and JS package build pass                                                                |
| Focused headless adapter/transform/boundary checks | 21 tests, 61 assertions passed; no GUI claim from these tests                                                                                             |
| Development native pointer                         | Real Increment click changed `Clicks: 0` to `Clicks: 1`, reordered/deleted keyed rows, painted the new state and closed with exit 0                       |
| AOT native pointer                                 | Same actual input and independent full-tree paint expectations passed; retained Alpha/Gamma native IDs, deleted Beta                                      |
| AOT native typing                                  | All 38 nonce-tagged ASCII input characters reached Solid state and both the native input and derived text paint; independent full-tree expectation passed |
| Solid cleanup                                      | Every tested native launch disposed all three keyed row owners and the application owner; adapter nodes/listeners returned to zero                        |
| Process cleanup                                    | All tested native launches exited 0 without forced termination or observed remaining/unreaped application processes                                       |

The actual keyed update required **one native text set, one insert/move and one delete**, with zero newly created nodes. The native host independently reported the same three-operation batch. This is a mutation-count observation, not a performance speedup claim. The development screenshot was visually inspected; the driver captures real native screenshots and native paint reports rather than generated imagery.

These initial runs are fresh-process software-GPU diagnostics. They do not establish a repeated performance distribution, physical input/frame latency, hardware GPU results, long-term leaks or a release-profile comparison against the direct core fixture. The established driver uses nominal 100 ms observation polling; its observed input times are not GPU presentation timestamps.

## Revision-aware input and retention increment

The next source snapshot builds on `001d8040ded554f21374b7419b42177448c8f76d`. [The machine-readable correctness record](../benchmarks/bn2/solid-native-correctness.json) retains the exact source/verification-file hashes, executable inspection, six native result digests, lifecycle records and mutation counts. The source was dirty when these observations ran; its file hashes identify the tested implementation. These are historical results for those recorded hashes, not qualification of the later listener/order fixes below. The host, compiler and software-GPU environment remain the ones listed above.

| Artifact                        |      Bytes | SHA-256                                                            |
| ------------------------------- | ---------: | ------------------------------------------------------------------ |
| Counter development module      |    103,860 | `8c3cf687f30fe24d8ba64f516f98fc835fb59f0bc21f1b7b5a3459767446e046` |
| Counter AOT executable          | 71,285,800 | `0646a40d1be3931d3c531ceb765f0fe5d94fae87c80c1998a11ae585a391de41` |
| Input-intent development module |     98,729 | `18913eba1d7717d6d8537e3df671ded310e8d02f170cffc13be9e2cae88583e1` |
| Input-intent AOT executable     | 71,236,648 | `9304ade44bb7bc363ee0b005871e2bc9d4b681dc87e5190e30996322771e00f5` |

Both AOT artifacts have the actual compiled-program flag `0x417c`, an unused JIT feature and 27 removed JIT ranges covering 14,297,303 virtual bytes. The interpreter remains present. These are untrimmed application artifacts paired with the existing development-profile host, not a release footprint comparison.

All three scenarios passed in **both development and inspected AOT**:

- The counter received a real native button click, updated its effect and label, moved retained Gamma ahead of Alpha, and removed Beta. Both launches retained all three originally created row identities and emitted exactly one set, one move and one delete.
- The counter received all 38 nonce-tagged native ASCII edits. Returning each actual `onInput` event to the Solid value signal produced observations without replacement commands; the 38 set operations updated only the derived text label.
- `tests/native/solid-input-intent.tsx` suspended the first native callback until revision 2 had arrived. Echoing the revision-1 event preserved native revision 2 and its value. After the complete 38-character value arrived, a new explicit replacement captured revision 38 and committed as revision 39. Independent full-tree native paint expectations matched `Explicit replacement` and the captured-revision label.

All six runs passed native-window, application-event, native-paint and OS-close checks, exited with code 0, and left no observed live or unreaped owned processes. The AOT counter and input-intent screenshots were visually inspected. The driver reports pixel/OCR assertions as unsupported; its exact full-tree paint checks and manual screenshot inspection are separate evidence.

At that snapshot, focused headless checks covered 17 tests with 109 assertions, including immutable intent capture, rejection of stale or foreign input intents, no replacement from delayed native-event echoes, retained descendants moved out of a removed parent, and rejection of a closed or cancelled initial mount without an acknowledgement. Strict checking covered 47 files. These tests run the actual public core against a headless subprocess peer; they do not count as GUI verification.

Repeated unmount testing found a real ownership defect: subscribing separately to an open window's completion retained disposed render roots. Sharing one observer removed most retention, but a closure environment still retained the first root. Creating the window-lifetime closure in a function scope without an individual root listener eliminated that retained reference. The committed regression forces the pinned Bun's full GC after ten mount/unmount cycles and observes zero reachable disposed roots while the window remains open. A separate 25-cycle check verifies one completion observer, all owner cleanups, and only the caller's native window root remaining. These bounded headless results do not establish native-heap or long-term leak bounds.

### Reproduce the native scenarios

Build either `examples/solid-counter/main.tsx` or `tests/native/solid-input-intent.tsx` with `bun scripts/solid-build.ts ENTRY ABSOLUTE_OUTPUT_DIRECTORY`, then compile that same generated `application.js` using `bun compile --no-script --production --explain=json`. Inspect the actual executable with the existing `inspectBunExecutable` and `inspectBunRuntime` functions in `experiments/aot-gpui`; a declared driver mode alone does not establish AOT or JIT omission.

With the pinned toolchain and the prerequisites in the native Linux workflow, this runs the compiled input-intent fixture:

```sh
export BUN_NATIVE_HOST=/absolute/path/to/prebuilt/bun-native-host
export BUN_NATIVE_HOST_PROFILE=dev
mkdir -p "$PWD/.bun-native/solid-input"
bun scripts/solid-build.ts tests/native/solid-input-intent.tsx "$PWD/.bun-native/solid-input"
bun compile --no-script --production --explain=json \
  .bun-native/solid-input/application.js --outfile .bun-native/solid-input/application
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$PWD/.bun-native/solid-input-session" -- \
  python3 tests/native/solid-window.py --scenario input-intent --mode aot \
  --output "$PWD/.bun-native/solid-input-result" -- \
  "$PWD/.bun-native/solid-input/application"
```

Use fresh result/session directories for each run. For development, pass `--mode development` and `bun ABSOLUTE_OUTPUT_DIRECTORY/application.js` as the application command. For the counter entry, select `--scenario counter-click` or `--scenario counter-input`. The wrapper only supplies independent expected trees and events, then replaces itself with the existing bounded native-input driver; it does not introduce another process supervisor or renderer.

## Recovered listener and ordering follow-up

The recovered source includes a correction for a listener race during native acknowledgement. A pending snapshot could retain an already-revoked unsubscribe handle when a button was removed and reinserted, leaving the adapter reporting a registration the core no longer owned. Live registrations now reside in a separate render-root map. Detachment revokes them immediately, and acknowledgement reconciles that live map. The regression requires the retained native handle to receive its next click through the actual public core and headless subprocess peer. Moving a subtree into an unowned container also revokes its listener immediately.

The keyed planner now retains a longest existing sibling subsequence. The 32-row rotation regression requires one move, zero creates/deletes and retained native identities. An independent exhaustive small-permutation oracle verifies the retained-subsequence length. These checks establish planning and ownership behavior; they are not GUI or performance measurements.

A workspace recycle preserved the earlier source/index checkpoint and these source fixes, but lost the subsequent benchmark tooling, raw repeated measurements, follow-up native records and temporary publication snapshot. The missing evidence is not recreated from summary statistics. The surviving correctness JSON above remains historical. Fresh development/AOT native runs and repeated measurements against the final shared host are required before this recovered follow-up can satisfy #231. The prior temporary executable, screenshot and log paths are no longer available.

The recovered source was revalidated with the restored checksum-pinned Bun: formatting, warnings-denied lint, strict checking of 49 files, package boundaries, 188 tests with 1,625 assertions, and the JavaScript package build all passed. These results validate the recovered source/process contracts, not the missing native or performance observations.

The [matched benchmark tooling](../benchmarks/solid/README.md) has since been reconstructed as a separate source increment. It builds independent direct-core and Solid applications, inspects their genuine AOT executables, binds results to exact source/artifact hashes, and separates native paint/GPU calibration from repeated timing runs. It preserves raw mutation, lifecycle, heap and fixed-checkpoint weak-target observations. No previous raw samples were recreated. Fresh execution against the final shared host is required before reporting new results; acknowledgement timings and live-heap snapshots do not establish input-to-paint or cumulative allocations.

## Regenerated protocol-2 native correctness

Fresh runs now qualify the existing six scenarios against source `657ac295077b381120ec8340d958b596da785b3b`, with the recovered listener and keyed-planner changes present. [The regenerated record](../benchmarks/bn2/solid-native-regenerated.json) retains 42 source/verification hashes, actual executable inspection, complete observed native results and 36 native/graphics-library fingerprints. These are new observations; they do not recreate the lost raw timing comparison.

All three scenarios passed in both development and AOT: the counter's pointer-driven label/keyed update; all 38 nonce-tagged native text edits and derived label; and the delayed native-event echo followed by a new explicit replacement at the captured input revision. Every launch satisfied its independent native-paint and application-event expectations, closed through the OS with exit 0, and reported no forced termination, remaining owned process or unreaped child. The AOT after-state screenshots were visually inspected. The race-specific remove/reinsert and 32-row rotation regressions remain headless until their dedicated native workloads run; these six scenarios do not substitute for those workloads.

| Artifact                        |      Bytes | SHA-256                                                            |
| ------------------------------- | ---------: | ------------------------------------------------------------------ |
| Counter development module      |    105,479 | `bf25a2fccf05251eaf17039daa60e18aca3c7ca79d38135b144b82fb9d7c5b67` |
| Counter AOT executable          | 71,302,184 | `b0b9ca8ad6009d74f2a3ed22d8c2e28d5e618ff4e0620687c73e00958ffc2a7a` |
| Input-intent development module |    100,348 | `e7cba8bb9c452564491f4fca3db4da3fce7ee4d5647bf8630c30aea5fc4d61f5` |
| Input-intent AOT executable     | 71,236,648 | `da0007dc1a29159e06e2b36a95fab42178ac06ab9b1953ecc7273e8e0a724fb5` |

The exact frozen host is 110,851,600 bytes with SHA-256 `55d2b9312529a01ccc3c4720f03040c4d685e7d51d9b7ece160f8b8e64ad7a49`, the corrected BN1 development-profile host. Both new AOT binaries have the compiled-program flag and validated unused-JIT/removed-range records; the interpreter remains present. The native host was not rebuilt for these runs.

The restored environment reports software llvmpipe LLVM 20.1.2 and Mesa `25.2.8-0ubuntu0.24.04.2`. This differs from the older recorded `.4` package revision, so the dependency hashes and package versions are captured afresh. The checks use actual XTest events in isolated Xvfb/Openbox sessions. They do not qualify physical input, hardware GPUs, macOS/Windows UI or a release-profile host. Native compilation elsewhere was permitted concurrently; every timing field in these correctness records is excluded from accepted comparative performance results.

## Shared renderer and merged BN1 qualification

After the shared renderer extraction and rebase onto the merged BN1 core, all six native scenarios passed again from clean source `331ef725b9da09313754473aa2e74cc2d404cb0e`. [The new qualification record](../benchmarks/bn2/solid-shared-native.json) binds the results to 45 source/verification hashes, including `packages/renderer`, the actual artifacts, 36 native/graphics-library fingerprints, complete driver observations, raw event-log digests and terminal owner-cleanup records. The older records above remain historical observations of their own source hashes.

The rebuilt development and machine-code AOT applications both handled the real counter click/keyed change, all 38 nonce-tagged input events, and the delayed native observation followed by a new explicit replacement. The independent native-paint expectations passed. Every launch closed through the OS, exited 0 without forced cleanup or observed live/unreaped descendants, and reported zero renderer nodes/listeners after owner disposal. Both AOT after-state screenshots were visually inspected; there is still no automated pixel assertion.

| Artifact                        |      Bytes | SHA-256                                                            |
| ------------------------------- | ---------: | ------------------------------------------------------------------ |
| Counter development module      |    108,713 | `909ea87fc3a39d399b13d6c87c04b8c9458a4ffc3ef59210640a102a26462f2a` |
| Counter AOT executable          | 71,302,184 | `cd01a1c083d8530bf61b063a059b027ecdb3d931f61b4816446c6e6448645e2d` |
| Input-intent development module |    103,612 | `332891fe61ff1c0c5a95b01233cad9ef779e9247c063ebb0bcf3e5b7ad5684ab` |
| Input-intent AOT executable     | 71,236,648 | `5f0af757326e0757a65743ba3f4b583d0cf089a0c5f0e2fe4331755b75122fca` |

The frozen host remains development-profile `55d2b9312529a01ccc3c4720f03040c4d685e7d51d9b7ece160f8b8e64ad7a49`; the GPU remains software llvmpipe with the recorded Mesa `.2` dependencies. Both AOT artifacts have the genuine compiled-program flag, JIT marked unused and 27 validated removed JIT ranges. The interpreter is present. No host rebuild was performed. These correctness runs do not establish release-host performance, physical input, GPU presentation latency, macOS/Windows UI, or the still-incomplete repeated benchmark.

The rebased source gate passed formatting, warnings-denied lint, strict checking of 67 files, package boundaries, 188 tests with 1,625 assertions and all JavaScript package builds. The actual pre-commit hook passed with the complete 43-file rebased candidate staged against merged main.

## Protocol-4 shared event properties

The shared renderer now maps eight native event types and both phases through one
immutable table: click, input, key down/up, pointer down/up, focus and blur. Solid
JSX derives all sixteen callback props from the shared public core types. Boxes
can observe descendant events. Per-element style types also preserve the shared
container-only scrolling contract.

`@bun-native/core` remains the only propagation implementation. The adapter
publishes each node/type/phase registration after acknowledgement and delegates
to `window.on`. It never reconstructs a queued route from the current staged
tree. A keyed move preserves the captured route; deleting the target cancels its
remaining authority, and a remounted node cannot inherit old callbacks. Replacing
one phase or event type does not revoke unrelated registrations. Input events
are recognized as observations before every callback, including ancestor capture
and bubble, without changing the revision of an explicit value intent.

Nine focused shared-renderer tests pass with 226 assertions over actual public
core IPC to an explicitly headless peer. They cover all event props and phases,
immutable descriptors, independent replacement, propagation stops, suspended
dispatch across moves/deletion/remount, input observations at all four route
positions, invalid props and leaf scrolling. These do not establish rendering.
Strict JSX examples reject unsupported physical key codes, repeat/default-cancel
fields, mismatched event fields and leaf scrolling.

The [native interaction qualification](../benchmarks/bn2/solid-events-native.json)
records 43 source/verification hashes, an identical source-rebuilt development
module, the actual AOT executable, 36 native/graphics-library fingerprints,
complete driver observations and terminal ownership records. Its Git commit is
the prerequisite base `3f9a3c8957bdb0d30455de0415bc3ae6f5e7da07`; the file hashes
identify the dirty Solid-events candidate that actually ran. Every captured
source file stayed unchanged through the AOT executions.

| Scenario                     | Development and machine-code AOT result                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pointer and Enter activation | Two actual native activations, correct capture/target/bubble routes, pointer `stopPropagation` and Enter `stopImmediatePropagation`; native activation still occurred             |
| Caret insertion              | Native click, Tab, Home, Right and `x` produced `AxBCD` at input revision 1 and the matching derived label                                                                        |
| Shift-selection replacement  | Native click, Tab, Home, Right, Shift+Right and `Y` produced `AYCD` at input revision 1 and the matching derived label                                                            |
| Cleanup in all six launches  | OS close, exit 0, no forced termination/live or unreaped owned processes, disposed Solid owner, zero renderer nodes/listeners and all six application ownership/queue counts zero |

The three fixtures observed 33, 67 and 75 callbacks respectively across 9, 17 and
19 native event groups in each mode. Each mounted seven renderer nodes and 48
event registrations. Both input scenarios stored the actual input event in Solid
state at all four callback positions; each still emitted exactly two native sets
(one counter and one derived label), with no input replacement. The keyboard
scenario emitted exactly two counter sets. All cases independently required the
complete native-painted tree at revision 3. AOT caret/selection screenshots were
visually inspected; there is no automated pixel or presentation assertion.

| Artifact                           |       Bytes | SHA-256                                                            |
| ---------------------------------- | ----------: | ------------------------------------------------------------------ |
| Interaction development module     |     118,130 | `24c9ef77f7e000e69404b2add06f4c90789b87fc7db0ea979d88e12f2722f27f` |
| Interaction AOT executable         |  71,711,784 | `adb49aed12d2dbb5f1a1de28efa182bff905a096b02ffa3e740ed7564878a751` |
| Frozen protocol-4 development host | 111,772,680 | `7e5acbd353f8e233364b11ad303a7ed32fb1566754663f75e85193ea2301c2cb` |

The host byte count and hash are retained in the machine-readable record. The
compiled application has the valid compiled-program flag, JIT marked unused and
27 validated removed JIT ranges; the interpreter remains present. The retained
compiler report contains 428 diagnostics, including dynamic-call/property paths
and eight compiler-reported missed optimizations. It is compiler analysis, not a
runtime profile or evidence that those paths dominate execution.

Build `tests/native/solid-interactions.tsx` with the existing `solid-build.ts`
recipe, then compile and inspect its generated module as above. Inside the owned
native Linux session, select `--scenario interactions-keyboard`,
`interactions-caret` or `interactions-selection` with
`python3 tests/native/solid-window.py`. Use the generated module with
`--mode development`, or the inspected executable with `--mode aot`.
The wrapper continues to replace itself with the existing bounded input driver;
it adds no independent supervisor. Its first attempted keyboard run rejected a
custom expected-event discriminator before application launch; the corrected
controller now requires an identified actual click/input record after the full
route and derived state qualify. That failed driver record is retained separately
from the six passing runs.

These are Linux Xvfb/XTest/Openbox and llvmpipe correctness checks with a
development-profile host. No native rebuild or second backend was introduced.
The driver's nominal 100 ms polling fields are not input-to-paint latency,
hardware presentation timestamps or an accepted framework comparison. Native
focus notifications retain GPUI's ordering, which may follow click dispatch.
Propagation stops govern JavaScript callbacks only; there is no asynchronous
native `preventDefault`, physical key code, repeat flag or pointer-move prop.
IME composition, programmatic selection/focus, complete text scrolling,
accessibility, release-host qualification and macOS/Windows GUI remain open.

The [protocol-4 regression record](../benchmarks/bn2/solid-events-regressions.json)
also qualifies the existing counter/keyed-list, 38-character input and delayed
input-intent fixtures in development and AOT against the generalized registration
driver. All six runs passed their independent full-tree paint expectations and
clean OS close. The keyed change still issued exactly one text set, one move and
one delete; all three row owners disposed. Ordinary typing still issued only 38
derived-label sets. Delaying the first input callback preserved the newer native
state, and the later explicit replacement used captured revision 38 and committed
as revision 39. Both compiled artifacts passed the same compiled-program/JIT
inspection. The fixture controller no longer assumes that click/input callbacks
have contiguous global event sequences: protocol 4 also includes key, pointer
and focus events. The runtime still validates every global native sequence, and
the controller still requires the complete nonce-tagged text and exact editing
revision. This is a protocol migration, not skipped input coverage.

The combined candidate passes workspace formatting, warnings-denied lint, strict
checking of 82 files, package/dependency boundaries and JavaScript package builds.
The canonical coverage command passes 356 tests and 2,301 assertions, with 99.14%
function and 98.10% line coverage under the existing thresholds. The actual staged
pre-commit hook and Python formatter/linter pass. The unchanged weak-target test
passed this run; that observation does not resolve the retained failures in #287.

## Problems found and next work

### Shared renderer extraction

The React implementation established a second consumer for the existing staging and native commit behavior. These implementations now reside once in `packages/renderer`, with framework-neutral node ownership and errors. Solid's mount wrapper registers `createRoot` disposal before component evaluation and inserts its component through the same Solid universal renderer. Its public `SolidNode` type names the shared opaque renderer node. The old Solid-private tree, input-intent, keyed-order and window-lifetime modules have been removed. Tests retain the existing delayed-acknowledgement listener race, revision-capture negatives, retained-descendant moves and closed-initial-mount checks against the shared implementation; the new six-scenario qualification above exercises this source refactor and merged core with its own exact artifact hashes.

The first fresh repeated workload on the pre-extraction source stopped at the direct-core AOT control's fixed weak-target checkpoint. Four native paint calibrations, four complete warmups and the first Solid development/AOT trials passed. The direct-core AOT trial observed two disposed handle targets from mount 61 after both fixed collection checkpoints, while all 3,200 repeated rows were disposed and every public ownership/queue counter returned to zero. The failed run is retained for investigation; it is not a completed timing comparison or proof of a renderer-owned retaining path. Weak-reference collection and actual native/core ownership are separate observations. [Issue #287](https://github.com/0xPlayerOne/bun-native/issues/287) and the [retention research archive](../benchmarks/retention/README.md) preserve the exact no-framework controls, visible retaining graphs and unresolved native observations. The existing GC oracle remains unchanged. A separate deterministic completion-observer regression includes two deliberately broken negative controls; it complements the unresolved weak-target diagnostic.

Bun's default package conditions select Solid's inert server runtime. The application build explicitly selects reactive client exports, and mounting with an inert runtime fails. Applying a global browser condition to all unit tests also selected Oxc's browser/WASM implementation. The narrow test loader therefore selects only the exact installed Solid reactive source while preserving Node resolution for other packages. Neither adjustment introduces DOM rendering.

A synchronous Solid tree must stage work until the asynchronous public core accepts a batch. Snapshots prevent later signal changes from rewriting an in-flight transaction; keyed identities survive reordering. Native validation failures dispose the Solid root and clean its prior committed subtree, with the error observable by callers.

Controlled replacement now carries an immutable value/revision intent from property submission through commit. An actual native event echo is an observation and emits no replacement, even after newer input arrives. Unversioned string changes fail explicitly. A stale explicit intent rejects and terminates that render root under the documented error policy; it is never silently authorized with a newer revision. `inputState(ref)` exposes the current shared-core editing state when forming a new intent. Protocol-4 props now expose the shared typed event and propagation contract; broader [#234](https://github.com/0xPlayerOne/bun-native/issues/234) text/platform qualification retains the explicit gaps above.

Before #231 is complete, retain repeatable dev/AOT keyed/reactive measurements, compare the same workload against direct core operations, exercise repeated mount/unmount and allocation/retention behavior, and complete the required hosted native acceptance lane. macOS/Windows GUI, IME, programmatic selection/focus, complete scrolling and accessibility retain their explicit platform/BN4 requirements. The five Adea component compatibility fixtures remain #233 work.

## Required hosted native acceptance

The required Linux native workflow now builds the three Solid entries through the
shared AOT helper: `solid`, `solid-input-intent` and `solid-interactions`. It runs
the exact fingerprinted generated module in development and its inspected AOT
executable against one independently built release GPUI host. Twelve scenarios
require the keyed counter, all input revisions, delayed explicit input intent,
keyboard/pointer/focus phases, caret insertion, selection replacement, complete
native paints and OS-close owner cleanup. The job retains the generated modules,
compiler manifests and raw controller evidence, including evidence after failure.

Adding this lane is source/configuration evidence until a hosted run passes.
Earlier development-host records above retain their original source hashes. The
lane's correctness assertions do not resolve #287, establish matched framework
performance or qualify a physical GPU, compositor presentation or another OS.

The integrated required-job recipe was then executed locally with the frozen
protocol-4 development host. [Its new evidence record](../benchmarks/bn2/solid-hosted-recipe-linux.json)
binds three source-fingerprinted generated modules, three inspected AOT artifacts
and all twelve passing native scenarios to the updated source and lockfile. It
retains original stdout/stderr/report/screenshot hashes and zero-survivor cleanup.
These local executions still do not substitute for the independent hosted release
build. The unchanged source coverage run passed 377 tests with 2,401 assertions;
an earlier run with six positive-peer startup timeouts is retained separately.
No timeout, coverage threshold, WeakRef assertion or production source was altered
to obtain the serial result.

## Explicit production framework modules

Inspection of the preserved generated-module source map above found
`solid-js/dist/dev.js` and `solid-js/universal/dist/dev.js`. The JSX preset's
`dev: false` did not choose production package exports. Those earlier native and
AOT passes remain evidence for their exact development-framework modules; none
of their source records or artifacts has been relabelled or replaced.

The builder now defines `process.env.NODE_ENV` as `"production"` while retaining
the existing `browser` export condition for client reactivity. An actual pinned
Bun conditional-export experiment under caller `NODE_ENV=test` selected
development for both `browser` alone and `browser` plus `production`. Adding the
explicit definition selected production dependency code and the production
constant. `tests/solid/build.test.ts` preserves that negative control and also
inspects the real native counter bundle for the production reactive and universal
modules, with no development or server distribution. No runtime or renderer
implementation changed.

[The new production-module record](../benchmarks/bn2/solid-production-recipe-linux.json)
binds 75 source/controller/inspector files, three generated modules and three
inspected executables to all twelve actual Linux scenarios. Each mode used the
same generated module, with its production framework distribution independently
identified through the source map. Every case passed once with full native paint
and application assertions, OS close, exit zero and no forced cleanup or observed
remaining/unreaped descendants. The shared renderer's ten files and the immutable
host's 27 native/toolchain build sources match the prior foundation exactly.

| Entry                | Generated module bytes |  AOT bytes | AOT SHA-256                                                        |
| -------------------- | ---------------------: | ---------: | ------------------------------------------------------------------ |
| `solid`              |                115,242 | 71,351,336 | `9fed2b3ff5aa9b71b4ec9fa44f9a164a64001f7524e805bbe191597a475fd7d7` |
| `solid-input-intent` |                110,223 | 71,302,184 | `e6a2a7980b03fd564a8653f34f9c80e569a68985c036a8eefa30cffc3bc8ddf9` |
| `solid-interactions` |                116,322 | 71,711,784 | `cd873d0831ace6d405c59c76f3783ac19e34b9c57f44e5b4888b806be6e40b34` |

All three executables contain the actual compiled program, mark JIT unused and
have 27 validated removed JIT ranges; the interpreter remains present. The
compiler consumed the exact generated module executed through ordinary Bun.
Development therefore names the runtime mode, while both modes use production
Solid dependencies.

These runs use the same development-profile host `7e5acbd353f8…c2cb` and software
llvmpipe as the earlier protocol-4 qualification. They establish neither a
release-host performance baseline nor a matched before/after timing improvement.
XTest input, full-tree paint and bounded owner/process cleanup do not qualify
physical input, compositor presentation, all allocation reclamation, another OS
or the unresolved weak-target observations in #287. The required hosted native
lane consumes this builder correction and must provide its own source-bound
release-host evidence.

## Main integration and current-lock control

The combined candidate merges main `d8bcae3130f9f95833bdfe864852d07078ab4dab`
(release 0.11.1 and the draft/ready CI concurrency correction), the production
builder above, and the opt-in [startup diagnostics](native-startup-diagnostics.md).
Main updates the native pins to serde `1.0.229`, serde_json `1.0.154` and
unicode-segmentation `1.13.3`. The earlier `7e5acbd…` and startup-diagnostic
`1a510561…` host records retain their original dependency hashes.

[The current-lock integration record](../tests/native/evidence/solid-main-integration-linux.json)
identifies a newly built development host, SHA-256
`72db09e99bd8956c7922498af007fe7bcd55030d8654d2ed7e2e30d1bb21bd4f`,
111,786,864 bytes, and 81 unchanged source/controller/inspector files. One
five-window lifecycle and one caret-editing control each passed once in ordinary
Bun and inspected machine-code AOT. Every lifecycle produced all 35 native open
markers, all five painted window identities and joined exit zero under the
unchanged 5-second request and 45-second fixture deadlines. Both caret controls
required actual XTest input, the complete `AxBCD` paint at input revision 1,
OS close and clean observed ownership. The AOT screenshot was visually inspected;
automated pixel assertions remain unsupported.

These four narrow integration controls complement the earlier twelve-case
production-module qualification. They do not requalify its historical binaries
against a different lockfile, establish complete Unicode/IME behavior, or replace
the required hosted release suite. Both new application executables passed the
compiled-program and JIT-removal inspectors; the Solid development module remains
the exact AOT input with production framework dependencies. The source gate
passed 385 tests with 2,573 assertions, strict checking of 89 files, formatting,
lint, boundaries, package build, Actionlint and session shell syntax. Current-pin
Rust formatting, warnings-denied Clippy and all 34 protocol tests passed.
The original hosted startup failure remains open in #296, and the unchanged
weak-target oracle does not close #287.
