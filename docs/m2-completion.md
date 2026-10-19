# M2 completion record

Reproducible local baselines and measurement infrastructure, with explicit release limits.

**Date:** October 19, 2026.
**Scope:** M2 issues #8, #9, #10 and #11; macOS acceptance plus portable tests.
**Decision:** Accept M2 implementation and the declared local benchmark profiles. Do not equate this checkpoint with production release qualification or a Bunly performance advantage.

## Acceptance and explicit scope resolution

The owner directed that missing Apple developer-account access be skipped and M2 closed.
Apple Developer ID signing, timestamped distribution signing and notarization are therefore
**skipped for this checkpoint**, not recorded as passed. Their existing implementation and
release-verification owner is M8 #41. No certificate, private key or trust-store change is needed
for the independently executed ad-hoc path below.

The remaining noise question is resolved at the **measurement-infrastructure boundary**:
M2 requires reproducible trials, uncertainty, environment observations, and rejection of
ineligible performance comparisons. Those mechanisms and actual local observations are complete.
A successful quiet-hardware calibration is **not claimed**. It remains explicitly pending in
M9 #44 before matched-engine comparisons or public advantage claims. This is a documented
checkpoint-scope decision, not a retrospective change to the measured data or CPU threshold.

The <=10% CPU condition, source-identity checks, security/browser cohort restrictions and
comparison gates are unchanged. The latest fixed preflight samples were
32.0%, 34.7%, 25.0%; eligibility was
false. None of the existing noisy records is relabeled
as controlled. No unrelated process was stopped and no sample was selectively discarded.

## Delivered acceptance

| Requirement                                     | Accepted evidence                                                                                                                         | Boundary                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Shared workbench and failure/reconnect behavior | #75: real frontend HMR, Electron/Electrobun/Mirin/Butter runs, backend restart and command reconnection                                   | Not native PTYs or M6 resource-preserving reload                               |
| Reproducible competitor baselines               | #76: seeded 16-sequence matrix; exact runtime/browser observations and fresh-install replay                                               | Different engine/security/source profiles remain separate                      |
| Input, stream, idle and memory measurements     | #76: trusted browser-input/xterm samples, native wakeups and descendant accounting; #77 adds attributed WebKit services                   | DOM/parser timing, not physical presentation; RSS is not unique RAM            |
| Build/development/release-stage separation      | Existing stage runners plus the separate executed local-signing path below                                                                | Source copy is not a new application build; Apple distribution signing skipped |
| Installed/download/cache/update bytes           | Real Mirin installation and full upstream updater transactions; separate signed artifact/archive inventories                              | No byte categories are summed or relabeled RAM                                 |
| Raw data, statistics and safeguards             | Versioned reports, source hashes, warmups/repetitions, failure retention, quantiles/variance, configurable budgets and comparison refusal | Quiet final calibration remains #44; goals are not measured advantages         |

Existing acceptance archives in `evidence/m2-macos`, `evidence/m2-measured` and
`evidence/m2-closeout` are retained unchanged. Earlier failures and unsupported platforms
remain visible. The WebKit service profile is explicitly a Launch Services wrapper profile,
not an invisible replacement for the prior direct-launch Butter measurements.

## Separately measured local signing

The new `scripts/qualify_adhoc_signing.py` works only with an explicitly hash-pinned
`dev.bunly.*` benchmark app under `.bunly`. It copies the input into a new private directory,
then re-signs every discovered Mach-O and nested bundle inside-out using identity `-`.
It preserves identifier/entitlement/flag metadata and never uses recursive deep signing.
Native verification is independent; `--deep` is used only for verification.

**Four actual trials passed:** one warmup and three measured repetitions, with **19 native
signing targets per trial**. Every run verifies all signatures, independently validates the
compressed archive, deliberately changes a sealed resource and requires native verification
to reject it, restores the copy, verifies it again, and checks that the source app is unchanged.

The input is a real prebuilt Mirin reference app, not a minimal synthetic executable.
Re-signing an already built app isolates this stage; it is not an unsigned-to-distribution
release pipeline or a claim of successful launch after every re-sign.

| Measured stage                           | Median of three non-warmup trials |
| ---------------------------------------- | --------------------------------: |
| Native ad-hoc signing commands           |                        1550.93 ms |
| Independent native verification commands |                        1258.55 ms |
| Portable tar/gzip compression            |                       20166.07 ms |
| Independent archive verification         |                        1333.25 ms |

These are local observations, not controlled release-performance numbers. Copy and inventory
work are recorded separately; signature bytes are included in the post-sign installed inventory.
The archive is a portable benchmark profile, not a native installer acceptance claim.

Execution source: `c2196814c31f0955326e0b90c0bcba4e1da6e0e4`. The report records clean source both before and after the run.
`evidence/m2-final/manifest.json` pins the exact source objects and the unchanged report bytes.

### Reproduction

Use the pinned Bun/Python setup in the benchmark guide. First create a private Mirin app using
the existing release profile. Obtain its inventory digest without modifying the source:

```sh
python -c 'import sys; from pathlib import Path; sys.path.insert(0, "scripts"); from native_signing_policy import snapshot; print(snapshot(Path(sys.argv[1]).resolve())["sha256"])' .bunly/path/Reference.app
python scripts/qualify_adhoc_signing.py .bunly/path/Reference.app .bunly/new-signing-run --source-inventory-sha256 <reported-sha256>
```

The output directory must not exist. Copies, caches and archives stay private under `.bunly`;
no binaries are committed. Platform-signing APIs and the actual `codesign` manual are the source
of the ad-hoc signing semantics; see Apple's Code Signing Guide, Requirement Language.

## Validation and remaining owners

The complete checkout passes `bun run check`, `bun run typecheck:browser` and Python discovery.
The additional policy tests cover identity-free commands, inside-out order, private scope,
source pins, linked/hard-linked input rejection, stale destinations, metadata and platform
refusal. Actual native runs, including the intentional tamper rejection, are separately preserved.

- **M8 #41:** Apple distribution signing and notarization remain unexecuted until independently
  available and explicitly authorized. No Apple account is required for continuing development.
- **M9 #44:** Quiet-hardware threshold calibration and matched-workload comparative decisions
  remain open. Existing noisy per-profile records must not support marketing speedup claims.
- **Native platform milestones:** No new Windows/Linux or production Bunly CEF validation is
  implied by these macOS reference-app measurements.

M1's existing closure is unchanged. M2 can close after this closeout and #77's native accounting
land; there is no remaining independent M2 implementation task hidden behind missing credentials.
CI billing remains paused. Publishing, security controls and Adea are unchanged.
