# M1 completion: foundations and host qualification

Feasibility evidence and a final host selection, not desktop release certification.

**Scope:** M1 issues #2–#7; last outstanding work #5.
**Decision:** [ADR 0002](decisions/0002-host-qualification.md).
**Selected host:** Prebuilt Rust GUI owner plus one supervised Bun 1.4.3 process.

## Acceptance mapping

| M1 work | Delivered evidence / boundary |
| --- | --- |
| #2: standalone scope | ADR 0001 and architecture; Bun TypeScript application model, no Tauri plugin or private Bun fork. |
| #3: monorepo | Existing contracts/client/runtime/artifacts/CLI/example packages, pinned consumer toolchain and compiler-free application build. |
| #4: provenance | Existing provenance inventory and upstream notices. This closeout copies no competitor code. |
| #5: hosting | All three candidates and three target classes have functional/fault evidence; startup/resource observations and actual Linux/macOS idle counters are consolidated. ADR 0002 selects the process baseline and explicitly declines Windows power-measurement support until qualified. |
| #6: portable contracts | Existing opaque resource handles, capability/version rules and browser-boundary tests. Real document authentication is M4, not a claim of these contracts. |
| #7: artifact foundation | Existing signed probe manifests, bounded extraction and verified prebuilt/offline consumer fixtures. Full CEF acquisition remains #16. |

The historical unchecked wording in #5 must be read with its final closeout:
Windows wakeups were not measured. The unresolved *support decision* is now made
and justified in ADR 0002; no unavailable value is converted into zero. M1 is a
host feasibility milestone. Required platform/browser and controlled-performance
acceptance for M2–M4/M9 remains open and is not satisfied by this closeout.

## Reproduce the evidence summary

The input manifest records six completed Actions artifacts by ID, run, target
and SHA-256. Download those existing ZIPs under their recorded `file` basenames;
this does not start a workflow. Then, from the repository root:

```sh
python scripts/summarize_m1.py --artifacts /path/to/downloaded-zips --check
python tests/m1_summary_test.py
python tests/kernel_counters_test.py
```

Without `--check`, the reducer writes `evidence/m1-host-results.json`. It validates
archive digests and member names, preserves member hashes, validates the full
fault/generation matrix, recomputes kernel deltas, and separates unavailable
counters and unpaired environments. It never downloads tools or starts CI.
The committed result retains measurement summaries and provenance, not every
raw trace. Original ZIPs have GitHub's stated artifact retention (October 31,
2026 for these runs); preserve them separately before expiry for later full
reanalysis. Hashes alone do not reconstruct expired raw data.

## Validation performed for this closeout

On Linux x64 with the supplied, hash-verified offline tools:

- Six input artifact digests verified; nine target/model rows reconstructed.
- Eighteen existing cross-platform lifecycle/fault cases independently checked
  against raw exit, orphan and application-assertion records.
- New evidence-reducer regression tests and the existing kernel-counter tests pass.
- The standard-library-only native host probe builds and its three unit tests pass
  with recovered Rust 1.91.0, `--locked --offline`.
- Local Bun 1.4.3 lifecycle recheck passes normal/hung FFI and Node-API Workers,
  the 28-generation process soak, and observed native-process abort. This recheck
  uses local Python/psutil 7.2.2; the preserved cross-platform evidence uses
  psutil 7.0.0. They are not combined into performance estimates.

The new implementation is an offline stdlib Python reducer, not a runtime change.
No new macOS/Windows/CEF, sandbox or full current-main TypeScript-suite execution
is claimed. M1 probe sources and reducer dependencies are checked against their
recorded repository identities. No native host, dependency, `.github` workflow,
billing guard, package publication or Adea production setting is changed.

## Residual risks remain in their owning milestones

Windows kernel/power measurement remains #9/#10/#22 qualification work. M3 must
qualify browser helpers, installed paths, sandbox state, process cleanup and
full-CEF acquisition. M4 must authenticate actual CEF documents and implement
persistent profiles/capabilities. Managed resource-preserving reload is M6.
Closing M1 approves the architecture baseline; it does not close those tasks.
