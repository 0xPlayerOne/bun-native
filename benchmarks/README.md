# Native performance evidence

BN0 first establishes a correct interactive GPUI fixture. Measurements must
identify the exact source revision, Bun/compiler/native revision, OS/architecture,
GPU/display environment, execution mode, command and raw samples.

Development (`bun run`), ordinary bundled JIT executables (`bun build --compile`)
and machine-code AOT (`bun compile`) are different measurement modes. A failed
or unavailable AOT run has no AOT performance result.

Capture cold launch, time to interactive, process-tree idle/peak RSS, CPU/GPU,
input-to-paint/frame latency, bridge traffic, artifact bytes and native build
duration. Repeat matched trials and retain distributions. Baselines and budgets
are established from the first correct native implementation, never invented.

The old CEF comparison harness and its results have been removed. Native
measurement harness implementation is tracked in [#258](https://github.com/0xPlayerOne/bun-native/issues/258).
