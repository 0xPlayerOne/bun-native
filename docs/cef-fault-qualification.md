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
