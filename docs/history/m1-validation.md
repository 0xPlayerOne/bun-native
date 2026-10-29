# M1 validation

**Record type:** Historical M1 validation; see [current validation](../validation.md).

Separate implemented checks from native and browser support claims.

**Status:** Foundation checks and native ABI probes passed on all three targets. Full host-risk qualification in #5 remains open.
**Implementation:** [PR #60](https://github.com/0xPlayerOne/bunly/pull/60).

## Verified baseline

[Run 38991991211](https://github.com/0xPlayerOne/bunly/actions/runs/38991991211)
passed for implementation commit `a6cd81fe287b7982d26c4dca37fbc4b30fa1db23`
(tested PR merge commit `9d08a2a4160b806d615b1402b4b831cf5877d619`).
The final close-callback and listener-snapshot regression cases were added after
this baseline; subsequent results are available in the PR's checks.

| Target                     | Frozen install, types, lint, boundaries, tests, build | Native build/tests | FFI / Node-API / subprocess | Verified artifact + offline reuse |
| -------------------------- | ----------------------------------------------------- | ------------------ | --------------------------- | --------------------------------- |
| Linux x64 / Ubuntu 24.04   | Passed                                                | Passed             | Passed                      | Passed                            |
| macOS arm64 / macos-15     | Passed                                                | Passed             | Passed                      | Passed                            |
| Windows x64 / windows-2022 | Passed                                                | Passed             | Passed                      | Passed                            |

Pinned versions: Bun (version redacted), TypeScript `7.0.2`, Oxc parser `0.154.0`,
Oxlint `1.18.0`, Rust `1.85.1`. Native sources have no third-party Cargo dependencies.

The verified Linux baseline ran 34 portable tests and three Rust tests. The
current suite adds two lifecycle regressions. The cache-filesystem symlink test
is explicitly skipped on Windows because symlink privileges are not assumed;
archive symlink rejection remains cross-platform. There are five fresh-process
trials for each of FFI, Node-API, and the subprocess fallback per platform: 45
successful host trials in the baseline matrix.

Each FFI/Node-API trial checks native ABI and a 16 KiB binary checksum, registers
an application-Worker callback, runs the native loop on its owning thread, and
completes 50 ordered callback round trips while Bun timers progress. Callback
cleanup completes before native-library teardown. The subprocess fixture proves
readiness, timer progress, request/response, and successful child exit.

## Artifacts and reproducibility

The run retains actual native probe archives, debug symbols, signed fixture
manifests, independent fixture public keys, SBOM inputs, consumer results, and
raw host reports for 14 days. The artifact IDs/digests are in
`evidence/m1-ci-baseline.json`; rerun CI to regenerate evidence after retention
expires. Private signing keys are ephemeral and are not written to artifacts.

The consumer probe resolves a verified artifact, reuses it offline, loads its
native library, and invokes its ABI. It does not compile a missing native
artifact. The unsigned Linux probe is 480,304 installed bytes in this run;
this excludes Bun, CEF, application resources, and helpers and is NOT a desktop
bundle-size claim. No competitor performance advantage is established by M1.

## Compatibility fixes found by CI

TypeScript 7's installed package did not expose the old JavaScript compiler AST
API. Boundary validation now uses Oxc independently of the typechecker. Bun's
FFI types required an explicit 64-bit mapping for the probe's size_t, and the
archive builder needed an owned ArrayBuffer return type. These changes were
validated with the pinned installed toolchain, not only the earlier local
TypeScript 5.8.3 / Node 22 portable checks.

## M1 acceptance status

| Issue | Implementation and evidence                                                   | Remaining boundary                                                                                                                   |
| ----- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| #2    | Architecture, scope, package/trust/lifetime boundaries, provisional targets   | Product outcomes remain hypotheses for M2/M9                                                                                         |
| #3    | Bun workspaces/lockfile, strict checks, templates, runnable mock and build    | Native application assembly is M3/M8                                                                                                 |
| #4    | Immutable reference inventory, import rules, licenses/notices and SBOM inputs | No competitor/browser code is imported; future imports need their own approved entries                                               |
| #5    | Real FFI/Node-API/subprocess probes pass on all targets                       | Idle wakeups, full process/thread accounting, sustained GC/reentrancy and fault/recreation coverage still need work; keep issue open |
| #6    | Portable SDK, fake backend and capability/lifetime/trust conformance          | Real renderer authorization is M4, not the mock                                                                                      |
| #7    | Actual native matrix artifacts, verified cache and offline consumer           | Production trust/key rotation, full browser archives and installers are later milestones                                             |

PR #60 implements the foundation but is not evidence that every criterion in
#5 is complete. Do not close M1 until the outstanding qualification is recorded.
Do not equate a mock suite, native ABI probe, or green build with a working CEF GUI.

## Known limits

No actual browser backend, terminal, renderer IPC, or hot reload is implemented.
There is no production signing trust root, key rotation, installer, updater, or
signed desktop distribution. The cache handles ordinary failures/cancellation,
not arbitrary power loss or an actively hostile same-user filesystem race.
Same-host service generation replacement is not proved by fresh-process trials.
Real platform event loops, CEF helpers, sandboxing, GPU/input/accessibility and
browser-loaded responsiveness belong to later native integration qualification.
