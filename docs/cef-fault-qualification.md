# Native fault supervision qualification

M5 #25/#27 regression coverage, not a complete terminal/process supervisor.

## Readiness before injection

The packaged asset module imports the real RPC client with top-level await.
The old fault application did not provide that service, so its four cases failed
at page readiness before any intended fault. The ordinary and fault applications
now share the same bounded fixture RPC handlers. The unchanged page must still
complete its asset and RPC assertions before `bunly.fault.ready` is emitted.
Missing service, failed assets, and incomplete readiness remain failures.

The shared service is retired when the fixture returns or fails. It does not
introduce a production API, fallback, relaxed document authority, or changed
request/shutdown deadline. Synthetic tests prove setup ordering and cleanup;
only actual native runs establish fault qualification.

## Current acceptance contract

`qualify-cef-faults.py` emits schema 3 reports with clean source identity, exact
harness fingerprints, complete input/prepared artifact inventories, and unchanged
before/after verification. Schema 3 additionally requires all native output
reservations to return to zero after backend exit and writer join. The prior
schema-2 readiness checkpoint retains its original guarantees, not a retroactive
output-accounting claim. It preserves all four attempts. A later successful
case cannot erase an earlier failure. Run with the pinned Bun and an explicitly
prepared contributor artifact; no credential-provider fixture is involved.

The bounded native diagnostic stream, not the last 20 stderr lines, is
authoritative. Readiness and descendant events are retained by the existing
allowlist. `cef_fault_acceptance.py` requires exact, nonduplicated readiness,
matching backend identity/exit, all four ordered teardown phases, and the correct
final clean/failed classification. Missing, reordered or duplicated receipts,
forced backend exits, unknown native failures, observer errors, orphan survivors,
and failed post-exit helper cleanup reject acceptance.

| Case              | Required behavior                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend exit      | Backend exits with code 23; native host detects failure, performs ordered teardown and exits 1.                                                                                                                                             |
| Backend tree exit | The controlled non-detached child must appear in process observations; backend failure must not leave it alive. This is not detached PTY or arbitrary shell-grandchild qualification.                                                       |
| Renderer exit     | Controller identifies one owned renderer by executable location, live process identity, ancestry and role evidence before terminating it. The native failure callback and backend acknowledgment must precede orderly failed-host shutdown. |
| GPU exit          | Recovery is gated on the actual owned GPU-process injection receipt; subsequent native view work completes, backend exits normally, and the host completes cleanly. This is not hardware-GPU performance qualification.                     |

Expected backend and renderer failures are **not clean application exits**.
They pass a fault-response test only when the complete failure and cleanup
contract is observed. macOS retains verified versus unobserved helper samples;
at least one verified helper completion is required within the fixed suite, and
all actual cleanup failures are fatal. No sampling retries are added.

## Automatic and manual execution

The automatic three-platform native job now uses the existing `full` selection:
RPC/prebuilt, browser policy, network, paired functional transports, offline
storage reset, process faults, then protected credentials. Manual `full` uses
the identical map. The narrower six-stage `m4-acceptance` remains available.
Provider installation stays last and cannot run if any preceding stage fails.
Windows/Linux full acceptance retains the additional observed OS-isolation
checks. Historical M3 results retain their original schema and engine scope.

## Boundaries

These cases exercise existing host supervision; this increment does not implement
terminal process-group registration, detached-descendant reclamation, Windows
terminal-job admission, graceful sidecar policy, restart/backoff, managed backend
replacement, or native renderer bulk streams. Those remain M5/M6 work. Passing
fault cases do not establish a causal fix for the historical CEF shutdown
watchdog intermittency. No security cloning, sandbox, provider guard, byte limit
or deadline is weakened to obtain acceptance.

## M5 extended supervision cases (schema 4)

The current full suite preserves the original four cases and adds two fixed
backend scenarios. Historical schemas retain their original case count; an older
receipt is not evidence that either new scenario ran.

`backend-hang` requests ordinary native shutdown and then blocks the Bun thread
with `Atomics.wait`, so application callbacks and shutdown listeners cannot run.
Acceptance requires the exact blocked receipt, the same backend identity, actual
forced termination after the unchanged native graceful-exit deadline, all ordered
native teardown phases, zero output reservations and no observer survivors. The
native host must return failed exit 1, not successful exit 0 or watchdog exit 2.
The minimum grace-duration assertion tests escalation semantics, not a performance
budget; no native timeout is extended to accommodate the fixture.

`backend-shell-tree-exit` starts an actual OS shell which retains a listening Bun
HTTP-server grandchild. The backend verifies one response from that private
numeric-loopback endpoint, then waits for the external observer to attest both
live descendant identities and their exact parent chain. The observer publishes
an atomic nonce-bound receipt; the backend waits via one filesystem notification
subscription and one deadline, not a timed sleep or transport poll. Only then does
the backend deliberately exit 23. Both descendants retain their process lifetime,
so native process-group/Job Object cleanup must reclaim them. This is explicitly
non-detached inheritance, not qualification of a PTY's separate session/group.

Every schema-4 trial also launches a separate, same-executable Bun process under
the test controller. It is not a child of the native host. It must remain alive
through native cleanup and then exit normally when its own input pipe closes.
Cleanup targets only its owned `Popen` handle, never a name-wide or PID-discovered
process. Missing, killed, substituted or accidentally included controls reject the
trial. These private processes are disposable qualification resources, not new
Bunly runtime sidecars.

The retained exit-notification and byte-accounting implementation is unchanged.
This expands observed failure/cleanup coverage; it does not implement terminal
process ownership, arbitrary detached descendants, termination-denial handling,
restart/backoff, managed backend replacement, or resolve historical intermittent
CEF shutdown behavior. Those remain explicit M5/M6 boundaries.

The first local schema-4 run completed native cleanup and preserved every foreign
control, but failed the new shell case because the parser incorrectly expected
parent IDs in the existing resource-sample rows. The corrected report retains the
actual parent/birth identities captured by the controller's sampling callback and
requires their PID/birth pair to match an actual resource sample. No parent ID is
invented for an older report; the original failed run remains failed.

### Windows shell command-line correction

The initial six-case Windows run passed the existing fault cases and the hung
backend control but failed before the new shell server's readiness: `cmd.exe`
reported a network-path error. The fixed command uses Bun's
`windowsVerbatimArguments` for its already-quoted `/d /s /v:off /c` expression;
CRT argument escaping must not add backslashes to that command-language string.
The executable/entry remain fixed fixture environment values, not user command
text. A Windows-only execution regression runs a real child from a Unicode path
containing spaces and verifies its shell parent. The full native case still must
prove a listening grandchild, independently observed ancestry, exact backend exit
and group/job cleanup. The failed platform report is retained, not reclassified.

## Explicit descendant-observation notification

The pinned macOS filesystem watcher schedules FSEvents registration asynchronously
and starts from the current event cursor. A receipt published immediately after
`watch()` can therefore precede registration. The retained local discriminator
failed 18 of 20 finite trials; resolving path aliases did not repair it. The
original failed logs remain separate from acceptance.

The shell-tree fixture now reuses its already-owned descendant HTTP listener for
a single retained observer notification. The observer first proves the exact
backend/shell/server ancestry and creation times, then atomically publishes the
same bounded receipt and sends one nonce-bound POST to numeric loopback. The
backend waits on one request, then independently reads and validates the private
file's identity, size and exact nonce/PID tuple. Early notification is retained.
Wrong, duplicate and oversized messages reject. The original deadline remains;
there is no filesystem poll, arbitrary sleep, retry-to-green, new process or
additional listening service. This is contributor fixture coordination, not an
application authority API or a same-user adversary boundary.

Upstream inspected: Bun commit `c6da4a4d3010e5553438c60f6bd76d981976867c`,
`src/runtime/node/fs_events.rs` (`register_watcher`, deferred `schedule`, and
`FSEventStreamCreate` with the current-event cursor). No Bun source was modified.
