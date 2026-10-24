# M4 completion

Native-bound IPC, scoped policy, explicit browser sessions and transport selection.

**Scope:** M4 #18–#22, functional acceptance on the declared CEF profiles.
**Delivery:** PR #103 is the final credential increment. M4 closes only after its
current-head platform acceptance and squash merge; no failed check is overridden.
**Boundary:** Not production-release approval, a complete security audit, or a
claim that the independently tracked CEF shutdown intermittency has been fixed.

## Delivered scope

| Issue | Delivered contract                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #18   | Typed RPC envelopes, bounded binary/structured messages and streams, cancellation, deadlines, teardown and execution accounting                                                               |
| #19   | Native-known view/main-frame/context/document generation and origin binding, restricted injection, revocation and hostile-frame/navigation qualification                                      |
| #20   | Explicit ephemeral/persistent sessions, sharing/isolation, private marked and locked profiles, cookies/cache/flush, complete offline reset, and opt-in verified OS-protected cookie admission |
| #21   | Native-scoped authorization and separate browser permissions, deny-by-default navigation/popup/protocol/certificate policy and a recorded threat model                                        |
| #22   | Matched native-mediated and authenticated-loopback candidates, retained measurements and baseline selection in ADR 0003                                                                       |

Native-mediated RPC is the ordinary baseline. Authenticated loopback remains a
contributor-only comparison because its browser reachability policy is not a
qualified shipping capability. There is no silent fallback, public debugging
endpoint, page-supplied view authority or zero-copy claim.

The native authorization boundary does not pretend to implement absent filesystem,
process, clipboard, dialog or download adapters. Those operations still return
unsupported until their later adapters are implemented. Remote pages remain
unprivileged, while same-origin scripts/XSS controlling a trusted main document
remain within that document's declared trust boundary.

## Session and credential guarantees

Persistent profile ownership uses the stable native host, not a reloadable page
or handler. A live root excludes concurrent offline reset; view/session disposal
and host shutdown preserve explicit ownership. Complete HTML5 clearing is an
explicitly confirmed **offline whole-profile removal**, not a partial first-party
origin sweep and not a live `clearSession({ storage: true })` implementation.
Other partitions, root-global data and external OS keys remain untouched.

Protected cookies are separately opt-in. A policy binds the root to application
identity and the selected provider. Native canary readback, flush and context
retirement precede read-only persisted verification and application admission.
Existing canaries, including interrupted unsealed proofs, are read rather than
rewritten. Missing/locked/unavailable providers, known weak fallback keys,
identity changes, malformed proofs and unsupported overrides reject admission.
The canary context never receives a renderer; only metadata survives retirement.

| Target          | Declared provider boundary                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64     | Application-specific Keychain service/account names; noninteractive existing authorization; a locked disposable Keychain is a negative control                  |
| Windows x64     | User-bound DPAPI-wrapped key, not Chrome's privileged app-bound service; exclusive cookie-file protection is retained; unreadable wrapped keys reject admission |
| Linux x64 / X11 | Explicit Secret Service provider with acknowledged Chromium-user-shared key scope; absence must not become a basic-store fallback                               |

Cookie protection does not encrypt every HTML5 store. Windows persistent roots
retain the documented 48-UTF-16-unit bound for the pinned nested storage layout;
maintenance can recover longer existing roots. Whole-profile reset is logical
removal, not secure overwrite, key deletion, snapshot deletion or a guarantee of
power-loss atomicity. Hostile same-user filesystem races remain outside the
private-directory/cooperative-lock threat model.

## Retained native checkpoint and final merge gate

The pinned engine is CEF 156.0.7 / Chromium 156.0.8078.17 with Bun 1.4.3.
The [sanitized checkpoint record](../evidence/m4-credential-checkpoints.json)
retains the actual three-platform result at implementation head
`b566a4c6d7f46c4f9071ca9ca06898f08b62880c`, tested merge source
`9b3facaff50f0da0c1302670303836a3cbd7cefd`, workflow run `40062320516`.
All three targets completed the original nine-case provider suite and the
adjacent native RPC/session, policy, network, paired-transport and storage-reset
stages. Engine identity, exact source, report fingerprints and cleanup outcomes
are retained. Source identity and input/prepared artifacts remained unchanged.

That checkpoint is **not** substituted for the later final head. The maintained
suite now adds an unavailable provider with an existing unsealed canary, requiring
its seal/nonce to remain unchanged: **ten cases on each target**. Final acceptance
requires the current head's normal validation and all three native jobs, exact
native receipts, successful provider-fixture cleanup, and unchanged source and
artifact inventories. The final PR #103 acceptance record identifies that head,
its tested merge tree, hosted runs and report digests. Only after that gate passes
may the PR, #20 and M4 be closed.

Earlier Linux restart and Windows read-only-open failures remain failed records.
The runtime fixes wait for actual cookie-visitor completion and release the
hidden native context before read-only SQLite verification; they do not weaken
Chromium's exclusive file lock. The separate macOS foundation-test deadline race
uses a deterministic fixture clock after actual HTTP admission; ordinary timers
and all application/native shutdown deadlines are unchanged. Initial unobserved
helper samples are not relabeled qualified. A successful repeated launch does
not erase a historical watchdog failure.

## Reproduce and interpret

Use the maintained local portable and native checks documented in
[validation](validation.md). `qualify:cef-rpc`, `qualify:cef-network`,
`qualify:cef-transports` and `qualify:cef-session-reset` operate on explicit
prepared contributor artifacts. `qualify:cef-credentials` additionally requires
an unprivileged **disposable GitHub-hosted runner**; it must not be enabled by
spoofing that environment on a personal machine. The automatic native workflow
runs the declared suites on all three platforms. Synthetic SQLite/provider tests
are not OS-provider evidence, and replaying retained reports is not new execution.

The earlier CEF 154 transport distributions remain version-scoped historical
measurements. CEF 156 functional qualification does not relabel them, establish
end-user latency, or prove a performance advantage over another framework.

## Remaining milestones and known issue

M5 owns real PTYs and streaming sessions. M6 owns supported backend generation
replacement/reconnection; current stable ownership is not a claim that managed
reload already exists. M7 implements the native OS adapters and integration
surfaces. M8 owns distribution signing/notarization, update/migration behavior and
broader release qualification. M9 owns controlled adoption/performance comparisons.

Issue #92 still tracks intermittent native CEF teardown. No deadline extension,
sandbox/security-cloning exemption or suppression converts that failure into
success. The functional checkpoint is not a release-support declaration.
