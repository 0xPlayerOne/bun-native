# M4 protocol increment

Typed application RPC and per-document capability policy.

**Scope:** #18 portable protocol; #19 host policy and adversarial fixtures.
**Base:** merged `1bb2df5cd2e10076d1a3dac21ca33dc592aa2edf` (PR #64).
**Historical Actions boundary:** The original portable increment did not run hosted validation.
**Current integration:** #94 adds the loopback candidate; #95 adds session APIs. The native-authority increment adds the ordinary three-platform adversarial RPC lane without changing repository settings.

## Delivered

The contracts/client/runtime packages now export shared procedure definitions,
typed client calls, capability-gated server routing, bounded binary framing,
request deadlines/cancellation, a bounded writer, and an acknowledged MessagePort
reference transport. The authority policy uses opaque single-use leases, exact
origins and native-known document/frame metadata; it revokes connections across
navigation and service teardown. Execution reservations remain charged across
connection replacement until old handlers actually settle.

Run `bun scripts/rpc-workbench.ts` for the executable protocol example. The
MessageChannel is real; its view registry is the explicit mock. No native browser
bridge is silently substituted or declared implemented.

The #19 native increment adds a CEF process-message bridge with native-created
document generations, exact main-frame/origin checks on every packet, one host
`RpcViewAuthority`, synchronous navigation/close/failure revocation, bounded
binary copying and renderer acknowledgements. `ViewTrust` is now sent to native
`view.create`; page packets contain no authority metadata or native control API.
The prepared-app qualification is `bun run qualify:cef-rpc -- <app>`.

## Earlier portable increment validation boundary

Local environment: Linux x64, Bun `1.4.3+c6da4a4d3`. Toolchain dependencies come
from the hash-verified offline contributor snapshot retained from PR #63. The new
files and the directly imported contracts/client/runtime entry points, mock and
registry are checked against the merged repository's content identities before
publication. This is scoped local validation, **not a fresh complete checkout's
cross-platform CI result**. Unrelated post-snapshot artifact/native changes are
preserved in the remote base tree and are not overwritten by this change.

- `bun test tests/rpc.test.ts`: 75 test cases pass, including 1,000 deterministic
  malformed-packet inputs, actual MessageChannel transfer/acknowledgement, real
  AbortSignals, injected monotonic deadline tests and reentrant authority changes.
- Final boundary review covers validation overrunning a deadline, reentrant grant
  replacement, and preventing unrelated backing-buffer bytes from crossing ports.
- Strict TypeScript and browser-only typecheck: pass on the local source set.
- Oxlint and AST package/browser boundaries: pass on the local source set.
- Compiler-free SDK builds and the executable RPC workbench: pass locally.

No CEF rendering, native sandbox, macOS/Windows behavior, browser-port teardown,
new benchmark advantage, or production readiness is claimed from these tests.
Existing M1–M3 outstanding criteria remain outstanding; moving independent M4
protocol work forward does not close them.

## Native authority review increment (macOS arm64)

The native protocol now carries a renderer-native context serial plus browser-owned
connection/document generation on every handshake, packet, receipt and revocation.
The renderer checks both entered and current V8 contexts; it does not hold registry
borrows while invoking JS or callback-capable CEF operations. Listener subscription
precedes server activation. Checked sequence parsing, stop-and-wait admission and
global retained-delivery reservations reject stale/replayed/foreign messages without
mutating live work. Bridge readiness uses one removable listener and deadline timer.

Contributor-only native probes replay actual previous bindings after context
replacement and inject foreign frames, forged metadata and stale responses. The
external hostile-frame script must demonstrably execute under the unchanged CSP.
Prepared-app acceptance requires exact RPC evidence, independent server validation,
backend-started cancellation, navigation/close-in-flight, return-to-origin denial
and bounded resources, as well as the original smoke and clean shutdown contract.

Local review validation uses Bun 1.4.3, Rust 1.91.0, the installed Python environment,
and the retained CEF distribution validated by pinned cef-rs revision
`163744c8286d5f593d89202c7807751a7898db28`. Real CEF linking, Rust tests/Clippy,
focused portable tests, strict/browser typechecking and compiler-free application
builds are distinct from native GUI qualification. No GUI is launched in the coding
sandbox. Full portable checks retain loopback bind failures and process-observer
`sysctl(KERN_PROC_ALL)` permission failures; they are not passing checks.

See [validation](validation.md) for preparation and the supervisor's maintained
`qualify:cef-rpc` command. Native adversarial behavior still requires that actual
run; CEF teardown issue #92, genuine remote/redirect platform coverage and other
supported operating systems remain open. Main-world XSS and same-origin scripts
that control the parent are not isolated by this bridge. Lost renderer receipts
remain charged against the hard native delivery budget until host teardown.

## First supervised native RPC trial and diagnostic revision

The first installed trial of the retained prepared app failed the direct iframe
borrowing assertion. It did not record which JS outcome caused that assertion;
it is not proof that native accepted the call. Native shutdown phases completed
without the #92 teardown failure, but the backend failed and the run did not pass.
The original app, report and source/artifact metadata remain immutable.

Inspection of pinned CEF 8037 and cef-rs found a concrete exception-output bug:
replacing the borrowed Rust string did not populate CEF's output slot. A real,
non-GUI C ABI regression reproduces the empty slot and passes with `try_set()`.
That check runs in a bounded child process to isolate Chromium library loading
from the other native tests. A new private diagnostic candidate records capped
native current/entered/bound frame provenance and exact JS outcomes while retaining
the specific cross-context-denial assertion. It still requires the supervisor's
actual CEF run; no successful direct-borrow denial or universal caller identity
is inferred from string-ABI tests or V8 creation-context annotations.

## Acceptance mapping

| Issue | Implemented here                                                                                                                                                                                       | Still needs integration/evidence                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #18   | Versioned envelopes, inferred routes, independent parsers, sanitized errors, monotonic IDs, binary bodies, cancellation/deadlines, disconnect/reload behavior and bounded admission/delivery/execution | Native renderer integration and platform execution are deliberately separate; the portable implementation is covered by local tests.                                                    |
| #19   | Host-side leases plus CEF browser/frame/document attestation, exact-context injection, native navigation-start revocation, bounded acknowledged binary transport, hostile child/forgery/stale fixtures | Execute and retain prepared-app evidence on every supported native target; remote network pages remain blocked by the current M3 navigation profile. No loopback transport is selected. |
| #22   | Acknowledged bounded MessagePort reference plus opt-in authenticated Bun loopback candidate, adversarial real-socket tests, candidate profiler and incomplete ADR template                             | #19 native-private handoff/CSP integration, paired native-mediated CEF trials, throttling/disconnect/platform wakeup evidence and final selection.                                      |

See [application RPC](rpc.md) for APIs, serialization limits, timing rules,
capacity behavior and the native integration contract. PR closure should not be
used to imply that #19, M4, or the earlier milestones are fully complete.

## Resumed native-authority integration

The direct same-origin child-borrow regression now observes both native rejection
and the exact JavaScript exception. The earlier missing CEF exception-string write
was corrected with the pinned mutable-string API, not by relaxing the assertion.

The expanded real-browser fixture then exposed independent child disposal closing
its parent widget, and a concurrent-close variant leaving a request unresolved.
The native lifecycle paths now distinguish independent view ownership from parent
widget teardown. Child/sibling preservation and the original 20-cycle concurrent
close workload are required in schema-4 RPC evidence.

A separate deterministic three-case regression demonstrated that delayed native
handshakes could recreate leases after local navigation, view disposal or window
close. A lifetime-retirement fence closes that race; a fourth regression covers
host teardown. The peer tests validate ordering, not native frame authenticity.
The prepared CEF fixture and hosted RPC suite supply the actual native boundary
checks. Issue #20 still retains its unsupported persistent-credential and complete
HTML5-storage-clear criteria. Issue #22 still requires paired native measurements.
No completion of M4 or correction of #92 is inferred from these increments.

## PR #96 completion pass

The retained final integration at `eb96269` completed the prebuilt lifecycle matrix,
including independent-view disposal and the original concurrent-close workload.
Its RPC wrapper nevertheless failed: the restored-installation launch lacked the
required native `wrong-frame` receipt. The other four positive launches contained
it. That failed wrapper remains failure evidence; the generic prebuilt pass is not
an adversarial RPC pass.

The hostile child was removed immediately after its JS outcome was inspected.
CEF documents that process-message delivery is not guaranteed during teardown.
The fixture now retains that child and waits for every native rejection receipt,
not just its JS onload or cross-context exception. The required case set is unchanged.
Deterministic tests reject page-only success, missing receipts and cancellation,
and cover early delivery and listener/timer cleanup.

The combined native fixture now validates session/view binding with live RPC,
isolated ephemeral cookies, referenced-session rejection, partition replacement,
stale-handle rejection and independently trusted versus remote replacement views.
Exact schema-4 acceptance includes this integration and ordered native shutdown;
macOS additionally requires qualified helper/clone completion. The original
20-cycle window/concurrent-close workload remains intact.

The initial fixture-lifetime candidate passed all eleven macOS prebuilt cases and
all five stronger RPC acceptance checks. A second candidate adding the combined
session workload also passed those cases. These are local development checkpoints,
not substitutes for final-head or other-platform execution. A preparation mistake
in an earlier new bundle omitted generated resources and failed before any native
launch; that zero-trial failure was retained and a new complete bundle was used.

Issue #20 retains unsupported secure persistent credentials and full HTML5 storage
clearing. Issue #22 retains native paired transport comparison/selection. External
network-origin/redirect coverage and issue #92 remain distinct; merging this
increment must not silently mark all of M4 or release qualification complete.

### Final local acceptance checkpoint

Clean implementation `83bff81e4e978ba62aad3fef0431ab73efd6d57e` passed the
complete eleven-case macOS RPC/prebuilt matrix: five successful native launches
with all eleven rejection receipts, exact schema-4 session evidence, ordered
teardown and verified helper/clone completion, plus six expected startup rejections.
A separate persistent-session suite passed ten cases, with its interrupted run
explicitly retained as an expected unclean negative control, not clean shutdown.

The ordinary host built without contributor probes also passed the eleven-case
smoke matrix. Applying the explicit RPC qualifier to that host correctly failed
with missing native probes; setting the fixture requirement cannot enable probes
that were not compiled. This negative control remains a failed native qualification.

Portable validation passed 669 Bun and 200 Python tests. The overlapping foundation
suite passed 139 tests. Native checks passed 3 M1 tests and 78 CEF tests in each of
the ordinary/probe configurations, strict Clippy, formatting and real release
builds. The isolated CEF string-ABI child is included in the 78, not an additional
test. All seven advisory scans completed with no reported findings: root and three
independent Bun locks, both Cargo locks and complete Python requirements.

The [sanitized local evidence](../evidence/m4-native-authority-local-2026-10-23.json)
records exact source/artifact/report identities and each disposition. Its final
code checkpoint is separate from this subsequent evidence-only commit. Hosted
platform outcomes belong to the final PR head and must not be inferred from these
local results. The original missing-receipt and zero-launch preparation failures
remain recorded; no test, native guard or deadline was relaxed.
