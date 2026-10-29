# ADR 0003: Renderer application RPC transport

Native baseline selection and a bounded, native-attested comparison.

**Status:** Native baseline selected; paired local qualification complete, final-head hosted execution tracked separately.
**Related issues:** #18, #19, #22, #9.
**Decision date:** October 23, 2026.

## Decision

Use **native-mediated CEF process messages** for the ordinary application baseline.
Keep authenticated loopback as an internal contributor comparison, not a supported
shipping transport or automatic fallback. Shared memory remains rejected: these
measurements do not justify its additional lifetime, synchronization and wakeup
protocol. Neither path is zero-copy.

The native baseline has the simpler authority/lifecycle surface and faster initial
handoff in the measured local workload. Loopback materially reduces the cost of
this binary batch, but currently needs an additional, fixture-only browser network
permission path. This is a real tradeoff, not a claim that native wins every metric.
A separately reviewed production permission design would be required before
shipping loopback, even where its throughput is attractive.

## Equivalent workloads and measurements

Both candidates use the same #18 envelope, runtime validation, capability policy
and native view/frame/document/session binding. The committed workload executes
100 structured calls at concurrency 16, 50 binary calls with 65,536 bytes each,
20 cancellations only after backend admission, and 20 calls under an acknowledged
native 4x CPU throttle followed by acknowledged restoration. It also exercises
navigation-in-flight revocation, return-to-origin denial, service disconnect,
server close and resource convergence. The loopback case additionally proves that
a second valid same-origin native owner cannot confirm a stolen socket credential.

Clean implementation `e36e3a07f4cf82761e4aad41d280c357b1defc1d` completed 24 native launches:
two warmups and ten measured trials per candidate, with alternating order. All
24 completed their exact workload and ordered shutdown, with verified macOS
helper/clone completion. Harness hashes and input/prepared inventories remained
unchanged. The independently probed runtime was CEF 154.0.34 / Chromium
154.0.8037.98 on macOS arm64, with Bun (version redacted). Sandbox configuration was preserved;
the binary identity probe itself reports sandbox attestation as unverified.

The following numbers are **whole-workload means**, not per-call latency. Brackets
are the maintained deterministic percentile-bootstrap 95% intervals for the mean.
These are ten local independent launches per candidate, not quiet-machine release
benchmarks or application startup/interaction speed claims.

| Workload                                 | Native-mediated            | Authenticated loopback  |
| ---------------------------------------- | -------------------------- | ----------------------- |
| First authenticated roundtrip            | 4.18 ms [3.85, 4.55]       | 9.61 ms [8.46, 10.86]   |
| 100 structured calls, concurrency 16     | 27.65 ms [24.86, 30.74]    | 20.40 ms [19.04, 21.89] |
| 50 binary roundtrips, 65,536 bytes each  | 459.98 ms [427.29, 491.03] | 33.60 ms [31.64, 36.23] |
| 20 cancellations after handler admission | 24.09 ms [19.78, 31.41]    | 15.20 ms [13.79, 16.94] |

Raw per-launch metrics, distributions, queue peaks, native receipts and provider-
specific idle observations are preserved in
[the sanitized local record](../../evidence/m4-native-transports-local.json).
The original observer reports remain private and are bound by SHA-256 and byte
length. No comparison ratio is substituted for a rejected or unavailable trial.

The two-second post-work idle window has one admitted control waiter and no poll
loop. Sampled macOS interrupt-wakeup rates averaged 84.88/s for native
and 108.78/s for loopback. These are matched-identity lower bounds during this
specific post-work window, not steady-state power measurements. Native and loopback
complete their preceding work at different times, so background browser age and
activity can influence these observations. Recorded zero package-idle deltas mean
zero in sampled matched intervals, not zero lifetime wakeups. Linux scheduler
counters have different semantics. Windows has no qualified collector and must
remain explicitly unavailable, never numeric zero.

## Bounded native path

Native packets remain limited to 24 KiB. Application frames are limited to 96 KiB
and fragmented only when required. Reassembly validates total length, sequence,
contiguous offset and exact chunk size before admitting data. A partial message
has one non-renewing ten-second deadline. The backend shares a 3 MiB reservation
budget across connections; renderer fragment ownership is independently bounded.
Revocation/cancellation releases owned buffers without releasing CEF-owned delivery
reservations early. Small messages keep their existing packet path.

Known native stages include RPC encoding, a writer snapshot, fragment allocation,
private-pipe hexadecimal encoding, CEF binary copying, renderer ArrayBuffer copying
and payload decoding. Loopback adds its binary record and payload isolation plus
a one-time native handoff/challenge. CEF internals, browser/Bun buffering and kernel
copies remain unmeasured. There is no complete-path zero-copy claim.

## Loopback authority and reachability are separate

The listener binds only numeric IPv4 loopback at an OS-selected ephemeral port.
It checks exact Host, Origin and path, uses bounded binary frames, and admits no
application packets before a one-use credential and fresh socket challenge have
both been confirmed through the exact native document owner. Credentials never
enter URLs. Replay, foreign sessions, stale bindings and alternate native owners
cannot claim that connection. Native control remains active for revocation; the
application data path bypasses the host without moving lifecycle authority.

Chromium's loopback-network permission is top-origin scoped. The CEF generic
permission callback does not attest the requesting frame. The contributor fixture
therefore makes a deliberately narrower **reachability** decision only when all
of these conditions hold: explicit endpoint configuration; the exact loopback
permission bit; the named packaged loopback fixture and an approved role; a current
native main-document binding; a live owner window; and an unretired local-only
**ephemeral** session. Its CSP names only that numeric WebSocket endpoint. It never
turns this network permission into RPC authority or claims to identify a requesting
child. The real foreign-owner attack remains mandatory after network admission.

This mechanism is compiled only with `rpc-qualification`. Ordinary builds reject
loopback setup, retain generic permission denial and do not open a listener during
normal startup. No global content-setting default, persistent grant, permission
UI bypass, browser-security flag, public debug port or arbitrary evaluation is
introduced. The fixture is not a design for arbitrary remote pages or persistent
application browser sessions. The baseline selection avoids this unsupported
shipping surface.

Pinned primary references: Chromium's
[permission registration](https://github.com/chromium/chromium/blob/154.0.8037.98/components/content_settings/core/browser/content_settings_registry.cc)
and CEF's
[permission callback contract](https://github.com/chromiumembedded/cef/blob/14c5a089e8452874cb1a556dc3fde26ed2d87723/include/cef_permission_handler.h).

## Failed controls and retained reporting corrections

The original ungranted packaged loopback control fails before WebSocket upgrade:
actual permission-denied receipts are retained, with no authenticated socket or
native confirmation. An earlier exact content-setting experiment did not survive
readback for the custom app scheme and was removed. Its source snapshot and failed
reports remain private. No broader default-setting or security-flag workaround
was retained.

The first fixture-grant trial completed application work but failed acceptance:
Chromium log noise displaced both native throttle receipts from the last 20 stderr
lines. That report remains failed. The observer now retains an independently
bounded complete allowlisted native stderr stream: at most 128 events, 16 KiB per
event and 64 KiB total. Duplicates are preserved and overflow fails; earlier failures
cannot be evicted or retroactively repaired. Final acceptance still requires both
actual throttle-completion receipts and every ordered shutdown phase.

Idle reduction also rejects contradictory availability, missing matched identity
intervals, duplicate counters, empty provider names and nonfinite computed rates.
Its regression failed before the fix and passed afterwards. The first Python audit
invocation used an environment without the audit module; the existing installed
audit entrypoint completed the retry without modifying the environment. Both
outcomes remain recorded.

## Maintained commands and qualification boundary

```sh
# Both actual CEF candidates; one functional launch each, not a distribution.
bun run qualify:cef-transports -- PREPARED_APP --functional

# Paired descriptive profile from clean committed source.
bun run qualify:cef-transports -- PREPARED_APP --samples 10 --warmups 2

# Independent native-only diagnostic, always non-comparable.
bun run qualify:cef-transports -- PREPARED_APP --native-only --samples 5 --warmups 1
```

The automatic three-platform RPC workflow requires both functional candidates as
well as RPC/session, native browser policy and network suites. Compilation and
local macOS runs do not substitute for final-head Linux/Windows execution. Hosted
functional results are not quiet performance distributions. Further production
security, signed application credentials, complete session storage clearing,
managed reload and the historical intermittent teardown issue are separate gates.
