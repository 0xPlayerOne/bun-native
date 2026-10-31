# Bun Native — architecture, code health and performance standard

**Status:** Engineering policy for the experimental Bun Native rewrite, October 31, 2026. Referenced from the [roadmap](https://github.com/0xPlayerOne/bun-native/issues/1) and root [AGENTS.md](../AGENTS.md). It applies to every BN0–BN7 task and pull request.

**Goal:** Deliver the smallest maintainable, fast, browserless native desktop framework that genuinely uses Bun machine-code AOT in production. Experimental means architecture can change quickly; it does **not** mean accepting dead code, fake tests, duplicated implementations, uncontrolled dependencies, regressions or a permanently messy repository.

**No human approval gates:** all checkpoints below are agent-owned technical verification. When a check uncovers a regression, investigate and fix it, document a deliberate tradeoff with measurements, or file a concrete linked follow-up while moving other independent work. Never call an unsupported result a pass. Normal GitHub protections and external credential boundaries still apply.

## 1. Architecture rules

- **One native host, two adapters:** the native window/render/event core is shared. SolidJS and React have separate reconciler adapters but do not duplicate Rust widgets, OS capability handlers, layout or text engines.
- **Keep dependency direction explicit:** public TS/JS contracts and types do not import platform internals; framework adapters depend on stable host abstractions; native Rust host implements those abstractions; components consume public host primitives; CLI/tooling composes packages but is not a runtime dependency of the components. Tests/examples are consumers, not a backdoor for privileged APIs.
- **Thin, measured native boundary:** prefer batched tree/property updates and bounded event queues, avoid excessive JS↔Rust crossing and per-node synchronous round trips, and ensure native UI-thread ownership, callback lifetime, cancellation and backpressure are explicit.
- **Model lifecycle and illegal states:** use discriminated unions/state transitions, typed handles, explicit window/view ownership, error categories, safe disposal and versioned ABI. Reject malformed or stale input at the actual native boundary; TypeScript types alone do not validate untrusted runtime data.
- **Separate product API from implementation detail:** application developers write TS/JS and import Solid/React components without Rust, Cargo, GPUI internals or a browser DOM. Rust/native compilation belongs to framework build/release; ordinary source edits use Bun.
- **GPUI is the starting renderer, not an immovable choice:** the agent may replace it with another genuine browserless native renderer based on reproducible evidence and an ADR, while retaining Bun AOT and the shared host/adapters contract. Never reintroduce a CEF/WebView fallback.
- **Choose a shallow, coherent package structure:** keep each package focused on a stable capability rather than creating layer-first folders, pass-through wrapper chains or generic abstractions with no real users. Proposed areas include host API, native renderer, Solid adapter, React adapter, native components, CLI, examples, tests and benchmarks; final boundaries are the implementer's responsibility.

## 2. Continuous clean-code rules

Every change must leave the touched area cleaner or demonstrably no worse.

- Delete obsolete Bunly/CEF source, dead branches, abandoned adapters, unused exports, duplicated fixtures, stale comments, outdated configs, unnecessary dependencies and obsolete docs **as part of the relevant change**. Git history retains old code; don't keep a compatibility museum.
- Check for **duplication, implicit coupling, circular dependencies, god files/classes, shotgun surgery, pass-through wrappers, wrong-layer validation, boundary leaks, and representable illegal states**. Split by responsibility when a change repeatedly touches unrelated modules; do not split into useless wrappers.
- Keep public contracts strict and types meaningful. Prefer precise TS/JS types, small explicit APIs, `Result`/typed errors and exhaustive handling. Justify `any`, type assertions, unsafe Rust and native FFI blocks in code review; keep the unsafe surface narrow and test it.
- Avoid unnecessary dependency growth. Audit imported runtime surface, licensing and native binary cost; prefer built-in Bun/platform facilities where they are correct. Do not introduce an extra bundler, renderer, process, JS engine or framework merely for convenience.
- Keep tests, examples, documentation, scripts, lockfiles, generated manifests, CI and package exports in sync. Add no generated build artifacts or caches to Git. Remove a superseded test only when its behavior is irrelevant or replaced by an equivalent _new architecture_ test.
- Favor straightforward, inspectable code. No duplicate Solid/React native primitives, speculative compatibility layers, hidden browser shims or permanent TODOs without linked issues and ownership.
- Run dependency/unused-code and boundary checks over changed packages and periodically repository-wide. Use tools selected for the actual stack; do not assume an obsolete Bunly script remains authoritative.

## 3. Performance engineering guidance

**Measure before claiming improvement.** Use the same source fixture, application behavior, OS/CPU/GPU, power profile, compiler version, renderer revision, build mode and instrumentation when comparing implementations. Preserve raw logs and source commits. Repeated runs and distributions matter more than a single attractive number.

### Bun AOT and TypeScript

- Use the current official Bun AOT compiler docs; pin exact version and target host. AOT compiles known code and omits its JIT, but includes a trimmed runtime and garbage collection.
- Inspect `bun compile --explain` output (when supported by the pinned version) for dynamic property lookups/slow paths and profile hot code rather than optimizing everything indiscriminately.
- Keep frequently executed data shapes stable and strongly typed. Avoid unnecessary `any`, broad assertions, unpredictable object shape changes, repeated serialization and runtime-generated hot code (`eval`, `new Function`, `node:vm`) when alternatives are viable. Confirm behavior in both dev Bun and compiled AOT.
- Measure GC/allocations, event-loop stalls, startup-to-interactive, idle CPU/RSS and bridge latency. AOT is not automatically faster for all workloads.

### Native rendering and bridge

- Batch layout/tree mutations across Bun↔native, avoid unbounded queues, coalesce redundant updates without dropping required events, and keep expensive work off the UI thread.
- Profile p50/p95/p99 input-to-paint latency, UI frame durations/dropped frames, long streaming updates, virtualization and text layout/IME. Avoid unnecessary redraws, repeated allocations, GPU resource churn, excessive copies across FFI and retaining disposed nodes/listeners.
- Track process-tree RSS/peak and idle CPU/GPU rather than a single process if helpers exist. Exercise mount/unmount, window open/close, repeated hot reload and long-running message streams for leaks.
- Compare identical workloads across Solid and React adapters and a direct native host baseline. Treat accessiblity/IME correctness as required behavior, not a performance knob to disable.

### Distribution and development loop

- Track cold launch, startup-to-interactive, installed/download bytes, native library count, release build duration, signing/installer overhead, edit-to-usable, native rebuild frequency and update/rollback time.
- Prefer prebuilt native host artifacts for app consumers. Use target-native AOT compilation where required. Reuse compiler, dependency and CI caches only when correct and measured.
- Do not optimize for a tiny executable by silently dropping runtime requirements, security checks, text input, accessibility or supported assets.

## 4. Checkpoints and evidence cadence

These are **automatic agent-owned** checks, never questions for the owner.

| Cadence                                   | Required activity                                                                                                                   | Evidence                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Every PR/commit series                    | Focused format/lint/typecheck/unit tests, changed-package dependency/unused-code scan, architecture boundary review, no stale files | Exact commands, results, diff/PR notes                           |
| Every merged behavior change              | Integration/lifecycle/error-path tests and targeted microbenchmark for touched hot path                                             | Native execution log and comparison to current baseline          |
| Every milestone                           | Full relevant native scenario, code-health sweep, performance profile and documented cleanup of superseded paths                    | Phase audit in epic; reproducible artifacts and remaining issues |
| Scheduled CI / before a release candidate | Full Linux/Windows/macOS matrix when supported; soak/leak, crash/recovery, accessibility/input and realistic workloads              | Versioned benchmark report, failures and unsupported cases       |
| BN7/release scope                         | Cross-framework, cross-renderer and competitive identical-workload comparison, public API/docs audit and release risk review        | Final support matrix and quantitative performance report         |

**Regression policy:** establish budgets from the _first correct native baseline_, not guessed competitor numbers. Trend medians and tails with repeated runs and environment metadata. Treat a reproducible unexplained regression around **10% or more** in critical startup, interactive latency, RSS, binary size or edit-loop metrics as an investigation trigger; particularly severe regressions should block the affected release claim until fixed or documented with a justified tradeoff. Noise, tiny absolute changes and benchmark methodology differences are not automatic failures. The agent may revise budgets with evidence and an ADR—no human sign-off needed.

Prefer a fast PR quality lane (target roughly five minutes when practical) with focused checks. Run heavier GPU/soak/benchmark cases on scheduled or release-triggered hosted jobs so ordinary iteration remains quick.

## 5. Milestone-specific technical audits

- **BN0 — foundation hygiene and AOT baseline:** old CEF source/workflows gone; package/dependency map clean; native window and AOT integration real; baseline cold start/RSS/bytes/build time and compiler slow paths recorded.
- **BN1 — bridge correctness and efficiency:** ABI and thread ownership audit; queue/backpressure/callback disposal, invalid-handle negatives, per-call/batch overhead and memory-retention test.
- **BN2 — Solid correctness/perf:** signals, keyed lists, mounts, effects and event mapping; measure update cost, allocation, component reuse and unmount leaks.
- **BN3 — React correctness/perf:** reconciler scheduling/commit, hooks/refs/errors; compare equivalent native updates to Solid and profile extra bridge traffic.
- **BN4 — interactive UI and OS integration:** frame pacing, virtualization, scrolling, text input/IME/focus/a11y, native services permission/lifecycle, high-frequency streaming and extended session memory.
- **BN5 — dev-loop and CI:** clean template setup, compile/reload latency, 100+ reload cleanup cycles, native-only CI, fast checks vs nightly heavyweight gates, cache correctness and unused code automation.
- **BN6 — shipped app footprint:** AOT binary/package/install bytes, cold/warm startup, idle resource cost, native linkage, reproducibility, clean-machine tests, update interruption/rollback and crash diagnostics.
- **BN7 — final holistic audit:** large Adea-style and React reference workloads, matched baselines, source reuse, duplicate code/dependency audit, no obsolete files, documented support/quality limits and before/after optimization evidence.

## 6. Test implementation and unsupported results

- **Unit:** deterministic types, state machine, serialization, errors, cleanup, capability validation and reconciler mutations.
- **Integration:** Bun TS/JS ↔ native ABI ↔ GPUI real tree; event batching; native input/keyboard; AOT addon load; restart/reload; platform artifacts.
- **Real native UI:** open visible window, type/click/focus/scroll and assert changed pixels/semantics when supported; a mocked tree or successful build does not pass this gate.
- **Stress/soak:** repeat create/dispose, list updates, streaming, long sessions, Native memory/resource tracking and recovery from injected failures.
- **Performance:** reproducible fixtures, raw samples, pinned tools, comparable environment and pass/fail/unsupported status. Save source commit, hardware, OS, power mode and build mode.
- **Security:** unauthorized native capability tests, malformed events, update integrity, untrusted content, stale handles and crash report redaction.
- **Platforms:** GitHub-hosted runners first; connected Mac via Remote Desktop Commander for actual GUI cases; containers sparingly on Mac. If hardware cannot prove a required scenario, mark it unsupported and link follow-up while continuing independent work.

## 7. Agent PR checklist

Before marking a PR ready for auto-merge, answer in its description:

1. What user-visible or framework behavior changed, and why is the architecture boundary still coherent?
2. Which old paths, exports, tests, dependencies or docs were removed or replaced? Is there duplicate code or a new long-lived abstraction without justification?
3. What exact checks ran under Bun dev and AOT, Rust native host and supported platforms? What is skipped/unsupported?
4. What performance metrics changed against which reproducible baseline? If no metric applies, why?
5. What lifecycle, security, accessibility, input and failure paths were exercised?
6. What decisions or tradeoffs were recorded, and what linked follow-up remains?

**Close a milestone only after its checkboxes and audit evidence are true.** If a problem is not resolvable immediately, leave it open or create a linked issue and continue unrelated tasks—do not conceal it or ask for a human checkpoint.

Primary reference for AOT behavior: [Bun compiler internals](https://bun.com/docs/compiler/internals) and [Bun compiler compatibility](https://bun.com/docs/compiler/compatibility).
