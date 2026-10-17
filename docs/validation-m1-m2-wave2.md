# M1/M2 second continuation

Executable competitor and development evidence, with explicit measurement boundaries.

**Status:** Tested increment in PR #62; M1/M2 are not declared complete.
**Scope:** Issues #5, #8, #9, #10.
**Evidence checkpoint:** `evidence/m1-m2-wave2.json`.

## Working evidence

The code checkpoint `07fbd9e943fdcc7e48aaa0aede47a8610e84628d` passed all six
workflows listed in the evidence checkpoint. Subsequent documentation-only commits
can have newer run IDs; the checkpoint deliberately identifies an immutable source.

The new kernel collector observes Linux scheduler and Darwin kernel-attributed
package/interrupt counters for the FFI, Node-API and subprocess probes. Collection
has a separate workflow and does not affect the uninstrumented lifecycle baseline.
Windows returns an explicit unavailable provider. A green Windows collector job
means its availability/error handling and host probes pass, not that Windows
wakeups were measured.

The new bare-Bun fixture executes five development scenarios: launch, source edit,
syntax failure/repair, service bundling with executable-output validation, and
cancel/resume of a numbered command. One warmup and three measured repetitions
run on macOS arm64, Windows x64 and Linux x64. Readiness is verified by service
responses and revision/instance/state assertions rather than a fixed sleep.

The Electrobun adapter builds an actual CEF application with the pinned public
bootstrap/devkit, then launches its native executable on macOS arm64. Launch and
terminal-render scenarios each run once for warmup and three times for measured
smoke observations. Completion requires actual renderer execution and exact
terminal byte/checksum evidence where applicable. A process-tree observer checks
exit and known descendants. The application reports packaged Bun 1.4.0. The
reduced Chromium user agent is retained as an observation, not an exact binary
version. No comparative speed or memory advantage is asserted.

The existing sandboxed Electron fixture continues to run on Linux/Xvfb. Both
adapters use the shared frontend, but differing OS, engine/security metadata,
profile behavior and completion transport prevent direct performance comparison.

## Failures found and addressed

- Generated Windows projects in the system temp directory were rejected by
  Bun 1.4.3's watcher as outside the project. Adding cwd and a package manifest
  alone did not resolve the observed failure. Generating the private fixture on
  the checkout volume passes. Failure evidence:
  https://github.com/0xPlayerOne/bunly/actions/runs/39000777587
  This is a test-environment workaround, not a Bun runtime patch or proof of
  arbitrary cross-volume watch support.
- An intentional Electron crash could be requested before the initial load promise
  settled. The adapter now waits for both navigation and renderer readiness. All
  failures, including warmups, are printed and retained rather than hidden by a
  measured-trials-only summary.
- The result library previously ignored failed warmups when computing standalone
  performance eligibility, and recognized only the exact string `unverified` for
  security. Regression tests now reject those false-validity paths.
- A Chromium user-agent string may be reduced. The Electrobun result must keep its
  exact `engineVersion` null until an independent full binary identity is qualified.
- The fixture child controller now has explicit return types, cleared deadline
  timers, bounded teardown, and tests for output overflow, wait cancellation,
  timeout, predicate exceptions and idempotent close.

## Security and attribution

The completion-only loopback endpoint exposes no desktop capability. It uses a
per-trial token, exact posting origin, expected scenario, single result and bounded
body/deadline. Tests cover invalid configuration, unauthorized and cross-origin
requests, oversized bodies, mismatched scenarios, duplicate completion, failed
results and missing completion. It is not the future native IPC authority model.

Electrobun's `sandbox: true` disables framework RPC. It is not conflated with the
Chromium OS-process sandbox. Current measurements remain ineligible for a
performance claim regardless of successful correctness checks.

Kernel providers use documented/public kernel interfaces, not new native code in
the application. References for field meanings/layout:
- https://github.com/torvalds/linux/blob/v6.8/kernel/sched/debug.c
- https://github.com/torvalds/linux/blob/v6.8/kernel/sched/stats.h
- https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/resource.h

Benchmark-only runtime dependencies stay outside Bunly consumer workspaces. See
`docs/provenance.md` and `THIRD_PARTY_NOTICES.md`. No upstream runtime is copied
into Bunly's native core, and no application artifact is publicly published.

## Remaining acceptance

#5 still needs Windows kernel-event instrumentation or a separately justified
support decision, plus final host-risk acceptance. The existing same-address-space
native-crash and callback-owner limitations remain.

#8 still needs frontend HMR and desktop-specific edit/relaunch integration. Disk
state and cursor reconnection fixtures are not managed persistence of windows,
terminals or arbitrary JavaScript closures.

#9 still needs the full stage/accounting matrix, calibrated configurable budgets
and controlled hardware-level evidence. Collector wakeups are not a battery test.

#10 still needs expanded Electrobun/platform scenarios, exact browser/sandbox
qualification and useful Mirin/Butter subsets. None requires blocking the first
Bunly CEF host on claims the current fixtures cannot establish.

CI raw reports are retained for 14 days. The committed ledger preserves source/run
identity and scope, not a permanent replacement for raw controlled benchmark data.
