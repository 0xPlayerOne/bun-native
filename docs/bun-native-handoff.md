# Bun Native implementation handoff

## Current branch state

The BN0 workspace replacement removes the Bunly runtime and browser renderer.
The source includes matching portable TypeScript and Rust native-pipe protocol
packages, an owned native-process runtime, an interactive GPUI host, strict
package-boundary checks, and a pinned Bun AOT/Rust bootstrap.
No old CEF result qualifies this implementation.

Source replacement [#264](https://github.com/0xPlayerOne/bun-native/pull/264) and
compiler interoperability [#265](https://github.com/0xPlayerOne/bun-native/pull/265)
are merged. Native window/AOT integration
[#266](https://github.com/0xPlayerOne/bun-native/pull/266) also merged as
`2c04f0ed991e8b5c5eecf56c9e07cbe3196e452c` after its full required validation
[passed](https://github.com/0xPlayerOne/bun-native/actions/runs/41180169500).
The repeated baseline/audit remains in
[#273](https://github.com/0xPlayerOne/bun-native/pull/273). Both application
modes have passed real Linux X11 software-GPU click/input/paint/close tests, and
five close/reopen cycles passed within one native process. Hosted native job
[124474016479](https://github.com/0xPlayerOne/bun-native/actions/runs/41179568675/job/124474016479)
also passed with the release-profile GPUI host and all 12 matched baseline trials.
The complete historical workflow failed its Windows protocol job. The corrected
Windows tests and all other #266 jobs subsequently passed; the rebased #273
checks and merge remain outstanding.

The [BN0 audit](bn0-audit.md) maps #227/#258/#226 to exact evidence, pending closure
conditions and later-platform ownership. The [integration record](bn0-integration.md)
preserves implementation decisions, earlier probes and reproduction. Neither
document declares #273 or the milestone complete before its remaining checks
and merge are verified.

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

1. Complete the current #273 checks on merged #266 and run its final required checks. Its bounded
   supervisor-termination correction and real-process regression are present;
   all 14 Python safety tests pass locally. The unused public re-export found
   during the audit is removed, with the internal validation bound retained.
2. Verify #273's merge, then update #227/#258/#226 and the milestone from that
   merged state. Preserve the hosted release baseline and its original raw
   reports; the initial 12-trial native capture already passed.
3. Use the recorded fresh-process window observations, idle RSS and artifact
   bytes as the initial baseline. Controlled cold-cache startup and true
   input/frame latency remain unmeasured.
4. Extend the proven integration into BN1's reusable tree, handles, ownership,
   batching, capabilities and controlled-input revisions. Reuse the same host
   for Solid and React; do not introduce parallel native backends.

## Validation meaning

`bun install --frozen-lockfile`, `bun run check`, and Rust protocol checks test
source, framing and dependency boundaries. `bun run build` emits JS modules and
is explicitly not an AOT executable. Initial unit tests are headless; they do
not prove GPUI rendering, input, GPU acceleration or AOT compatibility.

The native window and same-window AOT have real Linux software-renderer evidence
with both development-profile and release-profile native hosts. A successful
native job does not imply a passing aggregate workflow or a production release.
Stable framework APIs, framework adapters, packaged releases and other platform
GUI support have separate acceptance.
Headless protocol success on macOS/Windows does not qualify their native GUI.
BN6 #246 and BN5 #256 own the remaining native platform matrix; BN4 #241 owns
horizontal input scrolling, IME and complete accessibility qualification.

See [testing](testing.md), [toolchain](toolchain.md), and the issue/PR logs for
exact command results. Keep this document current as each implementation lands.
