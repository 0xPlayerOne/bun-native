# M1/M2 closeout and macOS application accounting

**Scope:** Closeout after merged PR #76. M1 is closed; #8, #10 and #11 are closed. #9 is the remaining M2 issue.
**Classification:** Executable accounting qualification. Not a controlled performance ranking or production release approval.

## OS-owned WebKit processes

The direct-launch Butter baseline deliberately counted only observed descendants.
A real diagnostic confirmed that its GPU, networking and WebContent services have
`launchd` as parent. It also confirmed that a shell-launched fixture can share both
coalitions and its responsible PID with its controller. Matching one of those
shared values would attribute unrelated application resources to the benchmark.
Those old records are not changed or relabeled as full-application memory.

The additional profile wraps the unchanged compiled Butter program in a private
`.app`, signs that local wrapper ad hoc, and launches it through Launch Services.
A fresh bundle identifier isolates the launch. The wrapper, signing and launch
costs are disclosed; this is not a substitution for the direct-launch baseline.

`scripts/macos_app_accounting.py` requires all of the following:

- An authenticated workbench registration followed by exact native executable and
  creation-time verification of the reported process.
- A self-responsible application, with both coalition IDs different from the
  accounting controller. Shared or unavailable identities fail the observation.
- For an OS-owned engine service: the same user, the application's responsible
  PID, both matching coalition IDs, and a canonical system WebKit XPC executable
  path with an allowlisted bundle/role. Process names alone are insufficient.
- Stable process identities before and after resource reads. GPU, networking and
  WebContent roles must all be observed throughout the declared sampling interval.

Root/descendant and OS-service observations remain separate. The combined peak is
calculated from each simultaneous sample, not by adding independent process peaks.
RSS still double-counts shared pages: it is not unique physical memory or a
cross-platform equivalent to proportional set size. Native wakeup counters retain
their provider-specific meaning. Short-lived processes, unknown service types and
other OS-wide costs are outside this bounded observed scope.

The collector only reads. It never signals OS services, moves processes between
coalitions, changes priorities, or alters sandbox/TCC/trust policy. Application
shutdown uses the private fixture's authenticated quit request. The launcher and
registered application exits are checked independently; the original application's
parent tree is not treated as owning a Launch Services process.

## Reproduction

Use the existing exact Bun 1.4.3 and isolated Python environments from the benchmark
guide. The contained Butter source/helper-primed installation must already have
been prepared by `scripts/bootstrap-reference-baselines.ts` with its committed lock.
The runner refuses a different platform or runtime package; it does not install a
replacement browser, pick a signing certificate, or touch another checkout.

```sh
BUNLY_KERNEL_COUNTERS=1 bun scripts/qualify-webkit-accounting.ts 3
python -m unittest discover -s tests -p '*_test.py'
bun run check
bun run typecheck:browser
```

The command executes one warmup plus the requested independent repetitions.
Each repetition builds the actual upstream program, prepares its wrapper,
checks the local signature, renders the entire shared terminal workload, requests
an idle window, records five seconds of attributed resources, and checks exit.
The private application and raw reports remain under `.bunly/acceptance/m2-closeout`.
An unexecuted or failed repetition cannot be replaced by a zero measurement.

Ad-hoc wrapper signing is explicitly a local wrapper re-signing measurement. It
is not the missing certificate-backed release-signing result, a Developer ID
identity, notarization or user-distribution approval.

## Native provider provenance

The implementation uses API contracts, not copied upstream implementation code:

- Chromium's use of `responsibility_get_pid_responsible_for_pid`:
  https://chromium.googlesource.com/chromium/src/+/refs/tags/134.0.6998.28/base/process/process_info_mac.mm
- Darwin `PROC_PIDCOALITIONINFO` and `proc_pidcoalitioninfo`:
  https://github.com/apple/darwin-xnu/blob/main/bsd/sys/proc_info.h
  https://github.com/apple/darwin-xnu/blob/main/bsd/kern/proc_info.c

These are private query ABIs, not a public supported SDK promise. Their symbols,
returned byte count and identity invariants must match on the execution machine;
unknown platforms, unexpected layouts and query failures fail closed. The measured
macOS profile is not automatically qualified on a future OS release.

## Remaining M2 acceptance

M1 has no outstanding implementation or metadata action. #9 is not closed by this
accounting increment alone. Certificate-backed signed-release timing and quiet
controlled calibration must still run under their declared prerequisites. The
unrelated local signing identity is not implicitly selected. The original <=10%
background CPU condition is not raised, and unrelated applications are not stopped.
Successful application behavior on a noisy machine remains local observation.

`docs/m2-comparative-acceptance.md` and `evidence/m2-measured` retain the existing
native first-run/update, input, stream and reference evidence. No older evidence
is overwritten, promoted to a stronger run class, or made browser-equivalent.
No GitHub Actions dispatch, CI billing change, runtime/SDK change, package
publication or Adea change is part of this closeout.

## October 19 execution and final disposition

The final one-warmup/three-repetition run passed from clean commit
`3b853f19d59befcbcae1ce946f5dacb186b882d8`. Each repetition observed two app
identities plus four independently attributed WebKit XPC identities, required
all three engine-service roles throughout its samples, and independently checked
the registered app's exit. Native wakeup counters were observed in every run.
The prior four successful qualification runs are also retained, with their own
source commit rather than relabeled as the final implementation.

| Final repetition | Samples | Sampled interval (ms) | Simultaneous attributed RSS peak (bytes) |
| ---------------- | ------: | --------------------: | ---------------------------------------: |
| Warmup           |      37 |                4956.0 |                                277692416 |
| 0                |      33 |                4923.9 |                                281608192 |
| 1                |      36 |                4932.7 |                                277544960 |
| 2                |      33 |                4786.3 |                                280412160 |

The final profile recorded Butter source 1.6.3, actual Bun 1.4.3, macOS build
25G241 and system WebKit 21624.5.1.11.3. The installed WebKit manifest is not a
per-process loaded-library attestation. Native responsibility and coalition
checks establish the resource association described above, not security-policy
equivalence to CEF. The local wrapper/profile difference remains explicit.

An actual shell-shared Python process was also submitted to the collector. It
was rejected with `app-is-not-self-responsible` and exit status 1. This negative
qualification is retained as a rejection, not as a passing memory measurement.

The separate prerequisite check took three consecutive one-second samples under
the unchanged policy: **23.8%, 32.1%, 34.2% total CPU**, all on AC, all above 10%.
The native code-signing identity query completed and exposed **zero Developer ID
Application identities**. No identity was selected or used and no private key
was read. Neither prerequisite is silently waived by these accounting results.

Preserved records and original/redacted/compressed hashes are in
`evidence/m2-closeout/manifest.json`. Each accounting report retains complete raw
sample arrays and per-trial summaries. Recomputing
`macos_app_accounting.reduce_samples(trial['accounting']['samples'])` exactly
reproduces each summary. The four final runs and four earlier runs are distinct;
within-run samples are not counted as independent repetitions. Private paths and
ephemeral fixture credentials are consistently redacted before committing.

Full-checkout validation: **412 TypeScript tests**, **103 Python tests** (including
14 new attribution tests), typechecks, lint, browser boundaries and compiler-free
builds pass. Touched Python/Oxfmt formatting and normal commit gates pass. These
are not new Bunly Rust/CEF, Windows/Linux or Developer ID signing results.

**Closeout status:** M1 and all six M1 issues are already closed. M2 has only #9
open. Its existing measurement infrastructure, actual installed updater and new
macOS accounting evidence are delivered, but certificate-backed signing and quiet
controlled calibration still need successful execution before #9/M2 closure.
