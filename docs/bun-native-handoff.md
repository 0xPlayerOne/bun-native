# Bun Native implementation handoff

## Completed foundation and current source

BN0 is complete. Source replacement #264, pinned compiler/native interoperability
#265, the actual GPUI window #266, and the repeated release baseline/audit #273
are merged. The final baseline merge is
`c7bcf4e63906b97c9639c7a48ca4645d06aa98d2`.
[Validation 41181547360](https://github.com/0xPlayerOne/bun-native/actions/runs/41181547360)
passed every required job, including actual release-host development/AOT input,
all 12 matched baseline trials, the Linux/macOS/Windows headless contracts and
`Validation / Gate`. BN0 #217 and its implementation issues are closed.

The [BN0 audit](bn0-audit.md) and [integration record](bn0-integration.md) retain
original hashed evidence and earlier failed probes separately from the final
passing run. That acceptance is Linux X11/XTest with Mesa software rendering;
it does not qualify other OS GUIs, physical GPU/input, IME, accessibility or
production installers.

BN1 is complete. The merged source in [#271](https://github.com/0xPlayerOne/bun-native/pull/271)
replaces the fixed fixture with protocol 2, a bounded multi-window native tree,
atomic mutations, independent input revisions and the public
[`@bun-native/core`](../packages/core/README.md) TS/JS API. Both framework
consumers import this same contract. Their type fixtures are compile-only;
actual framework renderers have separate acceptance.

The initial shared layout increment introduced protocol 3 and `layout_v1`.
Current protocol 4 additionally requires `interactions_v1`; the [event contract](native-events.md) records the shared native observation and propagation scope. Its [native layout contract](native-layout.md) records
the supported sizing, scrolling and focus behavior and its actual development/AOT
qualification. Historical BN1 artifacts remain evidence for their original
protocol-2 sources; old hosts fail negotiation with the current packages.

Real development and inspected AOT checks cover the public API and JavaScript
consumer, pointer/text/Enter events, stale-input rejection, 1,000 native
subtree/listener lifecycle cycles and 1,000 OS-delivered input events.
The complete required [hosted run 41224338023](https://github.com/0xPlayerOne/bun-native/actions/runs/41224338023)
passed the expanded release-host suite, actual startup/crash and scheduling
checks, native allocation profiles, the portable matrix and the aggregate gate.
The protected merge is `515c0bda14ce4f40c0ddd1469a161315d03356a8`.
The [BN1 audit](bn1-audit.md) links the retained raw archive, all eight inspected
AOT manifests, exact source identities and current performance observations.
Its Linux software-rendering scope does not qualify other native GUI platforms.

## Removal inventory (#251)

The baseline is `202e2d79299c1ed6e40627aa2ec81a9865bafe1f`.

| Area                                                  | Decision         | Reason                                                                           |
| ----------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `packages/{artifacts,cli,client,contracts,runtime}`   | Replace          | Browser runtime APIs, CEF distribution and obsolete Bunly contracts              |
| `native/{cef,cef-host,host-probe}` and old Cargo lock | Replace          | CEF implementation and legacy N-API experiments do not implement GPUI            |
| `examples/*`                                          | Replace          | Browser/HTML, terminal and old host fixtures                                     |
| `tests/*`, old `scripts/*`                            | Replace          | Assertions and qualification tied to removed runtime                             |
| `benchmarks/*`, `evidence/*`                          | Replace          | Historical CEF/competitor workloads and measurements                             |
| `provenance/*`                                        | Retire           | Removed source/dependency inventory; current attribution remains in root notices |
| Python manifests, browser TS config, old Cargo flags  | Delete           | No active consumer in the new implementation                                     |
| CEF/M1–M6/benchmark Actions                           | Replace          | Native validation must execute new code                                          |
| Code Foundry draft/release policy and root license    | Reuse            | Repository workflow and attribution remain useful                                |
| Bun Native architecture/quality/vision docs           | Reuse and update | Current product and engineering contract                                         |

Removed implementation remains in Git history. No compatibility API or browser
fallback remains in the active packages.

## Current implementation sequence

1. Preserve the merged BN1 scheduling, crash/startup, callback ownership and
   native allocation regressions. The final release suite passed; use its
   retained exact-source evidence when comparing future changes.
2. Continue the first Solid renderer under
   [#277](https://github.com/0xPlayerOne/bun-native/pull/277). Its isolated branch
   has actual development/AOT counter, keyed-list and controlled-input evidence.
   The shared-renderer refactor requires fresh native qualification and matched
   performance evidence; a failed retention investigation is not a passing
   comparison.
3. Complete the React renderer in [#280](https://github.com/0xPlayerOne/bun-native/pull/280),
   using the same private renderer package and public core as Solid. Preserve
   its measured handler-lifetime and error-propagation regressions.
4. Complete the required release checks for native layout/scroll/focus
   [#281](https://github.com/0xPlayerOne/bun-native/pull/281) and Bun command
   controls [#278](https://github.com/0xPlayerOne/bun-native/pull/278), then follow
   their issue dependencies. Ordinary TS/JS edits reuse a prebuilt host and
   must not silently invoke Cargo.

The native ownership and schema are described in [protocol 4](native-abi.md),
the [public API ADR](decisions/0004-public-api.md) and the
[security ADR](decisions/0003-bridge-security.md). Inspect actual branch/PR/CI
state before resuming; a draft implementation is not a completed milestone.

## Validation meaning

`bun install --frozen-lockfile`, `bun run check` and Rust protocol checks test
source, framing, ownership and dependency boundaries. `bun run build` emits JS
modules and is not an AOT executable. Headless subprocess tests use explicitly
simulated protocol peers; they cannot establish GPUI rendering or OS input.

[The native fixture guide](../tests/native/README.md) and [testing](testing.md)
separate actual native input, native fault containment, paint traversal,
process cleanup and AOT artifact inspection. Bounded ownership counts, weak
references and heap observations are not long-running allocator/GPU leak proof.
A native acknowledgement is not a display-presentation timestamp.

The initial baseline records fresh-process window observation, idle RSS and
executable bytes. Cache/power state is uncontrolled, observation intervals are
polled, and precise physical input/frame latency remains unmeasured. Preserve
these limitations when comparing results. BN6 #246 and BN5 #256 own the native
platform matrix; BN4 #241 owns horizontal input scrolling, IME and complete
text/accessibility qualification.
