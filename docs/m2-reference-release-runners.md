# M2 reference applications and release stages

Executable Mirin/Butter recipes, isolated native identity inspection, and verified stage boundaries.

**Status:** Implemented; real reference desktop and full release qualification remain open.
**Issues:** #8, #9, #10.
**Base:** Merged PR #71, `e8722cd305d97904d01d22504e20287212636df9`.

## Reference installations

The reference adapters invoke the upstream CLI and produced executable. They do not
replace a missing runtime with a mock, compile a private native fork, or silently
select a different browser. All data is from private generated local fixtures.

| Adapter | Exact packages | Browser/profile |
| --- | --- | --- |
| Mirin | `mirinjs` and `@mirinjs/cli` 0.1.0-alpha.26 | CEF; installed application directory |
| Butter | `butterframework` 1.6.3 | System webview; standalone compiled executable |

`benchmarks/adapters/references/*.package.json` describe separate contributor-only
depots. On a network-enabled qualification machine, copy the chosen manifest to a
new private directory and resolve it with Bun 1.4.3. Inspect the resulting `bun.lock`
and transitive graph, retain it, compute its SHA-256, and use frozen installation
for subsequent trials. No lockfile is invented from unavailable registry metadata.
The manifests are not added to the root workspaces or Bunly's runtime payload.

```sh
# After the separate depot has a reviewed lock and installed exact dependencies:
bun scripts/qualify-reference-app.ts mirin <depot> <lock-sha256> <report.json>
bun scripts/qualify-reference-app.ts butter <depot> <lock-sha256> <report.json>
```

The adapter validates the frozen-lock digest, installed manifest versions, entry
paths, and entry hashes. These observations are **not publisher/source provenance
verification**: `sourceVerified` remains false. The declared commit is the inspected
API reference, not a claim that registry bytes have been authenticated against it.

Each trial invokes the shared initial-build/launch/edit/invalid-edit/repair sequence.
Readiness requires independent host/document reports and the same xterm workbench's
complete bytes and checksum. Fixture disk state is retained; arbitrary JavaScript
state and terminals are not promised to survive. New private HOME and package-cache
paths prevent reuse of unrelated profiles. Inherited Mirin release/signing overrides
are cleared so a benchmark cannot accidentally select a production release identity.

Mirin's empty-window manifest opens the declared private fixture URL through the
public application API. Butter retains its bootstrap window plus the workbench
window. That extra window and Butter's native-shim compilation are recorded costs,
not removed to manufacture a favorable comparison. The Butter row is a system-webview
profile and must not be ranked as an equivalent CEF configuration. Actual platform,
shutdown, and bridge behavior still require execution of these pinned applications.

## Release-stage execution

`runReleaseWorkflow` accepts a **trusted local plan**, not input from a web page. A
plan declares commands, a separate verifier, dependency order, output paths, and
one explicit disposition for every stage. There is no string-to-shell interpolation.
Only a reaped command followed by a fresh nonce-bound verifier receipt and output
checks can pass. A zero exit code, stale receipt, old output, or missing stage cannot.

```sh
bun scripts/qualify-release-stages.ts <trusted-plan.json> <workspace> <report.json>
bun scripts/qualify-reference-release.ts mirin <frozen-bun.lock> <sha256> <new-project> <report.json>
bun scripts/qualify-reference-release.ts butter <frozen-bun.lock> <sha256> <new-project> <report.json>
```

The provided reference release recipes implement these distinct stages:

1. **Cold dependency installation:** a new workspace and private Bun cache; real
   `bun install --frozen-lockfile --ignore-scripts`; verifier checks actual manifests,
   package entries, and the retained lock. Lifecycle scripts are not silently trusted.
2. **Application assembly:** the actual upstream build/compile command; verifier
   checks the expected artifact, native executable format, and applicable Mirin
   manifest/Worker resources. This is structural verification, not a launch test.
3. **Portable archive compression:** deterministic tar/gzip over the complete actual
   application; a separate process checks member identity, modes, links, and hashes.
   It never extracts or executes archive members during verification.

The portable archive is an explicitly tuned distribution profile, **not** the default
DMG/NSIS/AppImage installer. It does not preserve or verify platform ACLs, extended
attributes, notarization, signing, installer integration, or updater behavior.
Installed file bytes and compressed archive bytes are measured independently.
Cache footprint is not network transfer. First-run download bytes remain unavailable
until independently instrumented. Failed stages publish no successful byte values.

Signing, installed first run, updates, and interactive development remain separate
plan stages. These presets mark them unsupported instead of treating assembly as
a substitute. A trusted platform plan can supply actual commands and verifiers for
those stages. Upstream build operations that combine acquisition/signing/assembly
remain combined; we do not invent precise split timings.

`passed` means all **configured** tasks passed. `fullStageCoverage` requires every
stage to pass. Always inspect both and the full stage matrix. Reports are local-smoke,
not controlled benchmark claims. Failed dependencies block dependent work, while
independent tasks can continue only if process cleanup is established.

## Exact CEF identity

```sh
bun scripts/inspect-cef-artifact.ts <trusted-libcef-binary> <sha256> <report.json>
```

A bounded Python helper validates the selected library's hash before loading it,
reads the public `cef_version_info` components and optional `cef_version_full`, and
checks that the bytes did not change. The helper is a separate observed process:
native aborts do not occur inside the benchmark controller. Loading still executes
native code; only an independently trusted installed library should be selected.
This is a process boundary, not an OS sandbox for hostile libraries.

The Electrobun qualifier now uses this binary identity instead of a reduced user
agent and rechecks the binary after trials. Mirin's reference adapter records the
final artifact identity separately. **Neither process sandboxing nor provenance is
established by a CEF version export.** Those fields remain unverified. System-webview
versions are not fabricated by this CEF-specific inspector.

## Cancellation and evidence

Commands are cancelled through a private, identity-bound observer input pipe. An
abort sent before Python initialization stays buffered and results in a cleanup
report. This avoids the old immediate-SIGTERM race and does not depend on Windows
signal emulation. An unresponsive observer has a bounded watchdog; if it dies
without a valid report, cleanup is unknown and fixtures are retained, not deleted.
Only observed owned process identities may be cleaned up. Sampling can miss very
short-lived descendants, so it is not a kernel-wide process-containment guarantee.

See `validation-m2-reference-release.md` for executed checks and remaining acceptance.
