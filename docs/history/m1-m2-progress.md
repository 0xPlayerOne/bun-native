# M1/M2 continuation

**Record type:** Historical checkpoint. Current status and commands are in [the documentation index](../README.md).

Qualification, workbench, and evidence boundaries.

**Status:** Implementation in PR #61. See the PR for the final checked commit and CI runs.

## Native hosting

The same native host now replaces Bun Workers repeatedly instead of launching a
new host for every trial. Both Node-API and FFI paths execute ordered generation-
tagged callbacks, reentrant native calls, 16 KiB checksum operations, GC pressure,
and timer progress. Faults include caught callback exceptions, early Worker exit,
idle timeout, and bounded termination of a hung Worker after native dispatch is
revoked. Old generations must exit before the next callback owner is installed.

The native-owner subprocess fixture uses matching 200 ms idle phases, 256 ordered
operations, and the same GC cadence. It recreates child processes in one host and
injects timeout, hang, and early-exit cases. Its callback-error equivalent is a
controlled protocol error outcome; it does not claim an in-process callback.
An isolated native abort tests observation of a real crash, not recovery from
native memory corruption within a running application.

The observer samples the full known process tree from outside the measured
application. It records RSS, threads, CPU, context switches and descriptors/handles,
with creation-time-aware cleanup, a fixed helper-exit grace, and raw phase samples.
RSS may count shared pages repeatedly. Short-lived descendants may be missed.
**Kernel wakeups are unavailable in the portable observer and are not inferred
from context switches.** Platform-specific kernel/power instrumentation remains an
explicit measurement gap; these smoke runs are not performance rankings.

## M2 workbench and fault infrastructure

The framework-neutral UI renders deterministic ANSI bytes through pinned xterm.js.
The local server supplies form/navigation, safe upload/download, streaming, and an
editable service. Its HTTP byte path is not a PTY or a native RPC benchmark.
The browser-only preview is a sandboxed iframe, not a native child view.
The Electron adapter adds actual independent browser windows, real renderer
execution, context isolation, Node-disabled pages, and explicit renderer sandbox
verification. No `--no-sandbox` comparison is supported.

The mock adapter tests the real portable Bunly contracts and explicitly marks
native rendering, real renderer crashes, HMR, backend replacement, installation,
and release stages unsupported. Fault-channel simulation is named separately
from real process fault injection. The ledger detects leaked handles, listeners,
requests, descriptors and processes; the observer separately detects a real
orphaned child before cleaning up only the observed owned process.

## Measurement contract

Every run contains the full variant/scenario/trial matrix, including failures and
unsupported work. Workload correctness must pass before a successful timing is
accepted. Quantiles, bootstrap intervals and shuffled trial schedules are
reproducible. Comparison rejects mismatched fixture, engine, security, environment
or scenario coverage. CI timings remain smoke evidence, regardless of their speed.

`references.json` records pinned competitor source inputs; source inspection is
not an executed baseline. The Electron adapter covers a bounded subset. Electrobun,
Mirin and Butter runtime adapters and the complete install/build/edit/release
matrix remain #10 work. M2 cannot be called complete from the mock or Electron
subset alone. Hardware-level input-to-photon and kernel wakeup metrics require
separate instrumentation; two animation-frame callbacks only establish a render
opportunity, not physical display presentation.

## Commands

```sh
bun install --frozen-lockfile
bun run check
bun run benchmark:smoke
bun scripts/bootstrap-benchmark-dependencies.ts
bun run workbench
```

For Electron use `bun scripts/bootstrap-benchmark-dependencies.ts --electron`,
install the pinned psutil contributor dependency with the same Python executable
passed through `PYTHON`, and run the documented adapter command in benchmarks/README.md.
Benchmark dependencies are intentionally separate from the root consumer SDK
workspace: each fixture has a frozen Bun lock, and Electron/xterm are not shipped
in Bunly's runtime. There is still no Bunly CEF window, PTY, or managed reload.
