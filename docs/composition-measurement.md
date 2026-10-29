# Descriptive windowed-CEF composition measurements

The `composition-profile` case supplies a repeatable resource baseline for
[issue #35](https://github.com/0xPlayerOne/bunly/issues/35). It measures the current
windowed CEF implementation under fixed API-driven work. It does not implement
off-screen rendering (OSR), infer GPU utilization from CPU counters, or qualify
physical input, IME, accessibility or display handling.

The report remains `performanceEligible: false`: this is a descriptive local
baseline, with no quiet-machine, power, thermal or comparative acceptance gate.
The older [functional composition fixture](desktop-qualification.md#view-composition)
retains its own unchanged workload and acceptance meaning.

## Explicit prebuilt and source identity

Use Bun 1.4.4, the contributor Python environment from `requirements.txt`, a
clean committed checkout, and a matching immutable native app. Replace `COMMIT`
with the full source commit used to build that app. The commit must already
exist locally and its `native/cef-host` tree must match the current checkout.
The runner never downloads or compiles a native host as a fallback.

```sh
bun run qualify:desktop /absolute/path/to/prebuilt-app --native-source=COMMIT --case=composition-profile
```

On macOS select the `.app` directory. Windows and Linux select the packaged
`bunly_host.exe` or `bunly_host` executable. Run as a normal desktop user, keep
the window visible and its geometry unchanged, and do not interact with it
during the finite workload. A hide, minimize, close or window-bounds notification
during measurement invalidates the attempt. Window activation at each phase's
start is recorded; the workload does not activate the window or claim continuous
foreground ownership.

The existing desktop qualifier copies the supplied app privately, bundles the
fixed application assets, applies local ad-hoc signing to the macOS copy, and
records the original and prepared inventories. It verifies packaged Bun and
exported CEF/Chromium identity, unchanged source/artifact bytes and metadata,
native shutdown, output drain, native ownership and process/helper cleanup.
The ordinary native request/shutdown deadlines and 45-second observer limit
remain unchanged. This new finite workload has a 35-second overall bound.

Records are retained under `.bunly/m7/composition-profile/run-*/report.json`,
including failed attempts and `trial.process.json`. Replay without launching:

```sh
bun run qualify:desktop --verify /absolute/path/to/report.json
```

The selected native build commit is an operator declaration cross-checked against
the local source tree; it is not embedded binary build attestation. Runtime
identity and complete inventoried bytes retain their separate meaning.

## Fixed workload

An 820-by-600-DIP native window contains two content panes and a native overlay,
each with a separate ephemeral session. All three use the same packaged static
HTML and CSS: a heading, fixed text and 24 grid cells. There is no renderer RPC,
animation, synthetic input, remote content or observation polling. This smaller
controlled workload is distinct from the interactive hardware workbench.

| Phase    | Minimum dwell | Work                                                                                                                                                                                                |
| -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warmup   | 2 seconds     | Two visible content panes; overlay remains hidden.                                                                                                                                                  |
| Idle     | 4 seconds     | Unchanged static documents.                                                                                                                                                                         |
| Resize   | 4 seconds     | 40 left-pane size changes at 100-ms scheduled intervals; each native geometry update and readback must agree.                                                                                       |
| Overlay  | 4 seconds     | 16 alternating show/hide operations at 250-ms scheduled intervals, ending hidden.                                                                                                                   |
| Recreate | 4 seconds     | Four cycles at 1-second scheduled intervals. Each disposes the overlay and left pane/session, reloads a new left pane/session, recreates the hidden overlay, and verifies the surviving right pane. |
| Recovery | 4 seconds     | Both content panes remain visible; no more lifecycle operations.                                                                                                                                    |

The schedule uses a monotonic application clock. Each operation is awaited;
operations never overlap to catch up. If an operation takes longer than its
scheduled interval, the actual phase duration grows and is retained. The workload
does not discard slow operations, extend native deadlines or declare omitted
operations successful. A single attempt contains 22 seconds of minimum phase
dwell plus setup/cleanup and any overrun.

The final receipt requires five left-pane and overlay incarnations, one surviving
right-pane incarnation, and no retained native view/session/queued-delivery owners
before shutdown. Those logical ownership observations do not establish released
GPU memory or returning RSS to a prior value.

## Measurement interpretation

The process observer timestamps samples using its own monotonic clock. Exact
fixed stderr phase markers change the observer's phase label when received.
The application separately retains monotonic phase start/end values. These
clocks are not treated as interchangeable: pipe delivery and sampling introduce
boundary uncertainty, and no CPU interval crossing a phase boundary is charged
to either adjacent phase.
The observer and explicit native readbacks add load; no overhead subtraction is
applied. The process tree describes the launched app and observed descendants,
not whole-machine CPU consumption.

Each phase summary retains:

- Process-tree RSS sample count, median, p95 and maximum, plus the peak observed
  process count. RSS sums can double-count shared pages and are not GPU memory.
- Sampled CPU seconds from adjacent samples with the same PID **and creation
  time**. New, exited and reused process identities are counted as unmatched
  intervals. CPU outside matched intervals is unobserved, not zero. A decreasing
  same-identity counter fails validation.
- Actual sampled span and largest inter-sample gap, so a sparse or interrupted
  observation cannot be mistaken for continuous accounting. Missing phase
  samples, unknown/out-of-order markers and malformed counters fail validation.
- API operation plus native readback duration, summarized within each phase
  using linear-interpolated quantiles. Recreate includes disposal, native load
  readiness and hierarchy rebuilding. These are not frame presentation,
  pointer-to-pixel, keyboard latency or paint measurements.

The full process samples and per-operation durations remain in the raw records.
Repeated intervals within one run are correlated. Do not pool them into a larger
independent sample count or manufacture confidence intervals from them.

For a descriptive equipment record, run one complete warmup attempt followed by
at least three independent recorded attempts on the same source/build/equipment.
Keep every attempt, identify the warmup before execution, and summarize each
recorded trial separately. Each command uses a fresh private app/cache; that
does not clear OS disk caches or establish a cold-start cohort. Record other
application activity, power state, OS/build, CPU/GPU, display scale and thermal
conditions. If conditions change, retain the attempt and identify a separate
cohort instead of silently discarding it.

## GPU, input and renderer decision

The observer's Chromium `gpu-process` role identifies a process; its CPU time is
not GPU utilization. `gpuMeasured` remains false. A separately retained platform
GPU trace may supplement a trial only when the record states the tool/version,
counter definitions, capture interval, exact process identity and attribution
limits. Machine-wide GPU utilization or memory counters may describe background
conditions, but cannot be attributed to Bunly. Missing or inaccessible counters
remain unsupported; no permission, sandbox or tracing restriction is bypassed.

Pair any renderer decision with actual K1/K2/I1/D1/A1/M1 observations from the
[physical qualification protocol](m7-platform-qualification.md), using the
[hardware workbench](hardware-workbench.md) on the identified source/build.
Automated geometry, native load notifications, DOM/accessibility snapshots and
CPU/RSS records cannot pass those cases.

Windowed CEF with explicit native overlays remains the implemented baseline.
First record a concrete user-visible limitation or measured resource problem
that requires an OSR prototype. A later comparison must hold content, action
counts, browser/runtime versions, sandbox, equipment and power/display conditions
constant, and separately test GPU work, IME, screen-reader semantics and physical
input. Until both implementations and those records exist, report a windowed-only
baseline and keep the comparative and physical criteria open. This command alone
does not close #35 or qualify M7.

## Portable validation

```sh
bun test tests/composition-profile.test.ts
python -m pytest tests/transport_phase_test.py
bun run typecheck
bun run typecheck:browser
bun run boundaries
```

The tests exercise receipt/phase ordering, exact operation counts, monotonic
sampling, PID reuse, counter resets, missing samples, RSS consistency and failed
fixture cleanup. They use synthetic parser inputs and do not launch a native app
or supply a performance result.
