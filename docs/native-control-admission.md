# Native control admission

M5 #26 increment. This bounds admission in the private **Bun-to-CEF command
pipe**; it does not implement the dedicated renderer bulk lane or a global
priority scheduler. Native origin/document authorization remains mandatory.

## Shared policy

`packages/runtime/src/native-capacity.json` is compiled into the Bun transport and
Rust host. These are simultaneous limits, not independently additive capacities:

| Limit                                           | Bound   |
| ----------------------------------------------- | ------- |
| Entire LF-inclusive command frame               | 64 KiB  |
| All outstanding Bun requests                    | 128     |
| Ordinary requests                               | 96      |
| All submitted, unsettled write bytes            | 1 MiB   |
| Ordinary submitted write bytes                  | 768 KiB |
| A frame eligible for reserved control admission | 1 KiB   |

Only exact `quit`, `rpc.ack`, `rpc.disconnect`, `view.dispose`, `window.close`,
`session.dispose`, and `credentials.discard` operations may use the reserve.
Oversized versions and all other operations use ordinary capacity. Page-supplied
priority fields, unknown names and name prefixes cannot select the control class.
Admission is not authorization: native dispatch still validates identities,
arguments, ownership and lifecycle. No new renderer API or permission is added.

The overall Bun 128-request / 1-MiB limits and native 256-task count are not enlarged. Ordinary traffic cannot
consume the final 32 request slots or 256 KiB of byte capacity. Control traffic
also has a hard total bound; a flood of control requests can still exhaust it.
Excess ordinary requests reject explicitly before submission, without silently
losing bytes or buffering retry promises. There is no automatic request replay.

## Ownership and ordering

Bun counts both pending and locally cancelled-but-unacknowledged ordinary requests.
Cancellation cannot recycle the slot: an actual native reply or transport failure
must settle its request ownership. Write byte reservations are separate and last
until the raw write callback settles, including after transport closure. A broken
adapter holding a write continues to appear in diagnostics rather than reporting
fictional zero retained bytes. A synchronous write failure releases its reservation.

The native pipe reader supplies the actual frame length, not a claimed payload
size. Native admission applies the same class with its separate retained-task bounds
before posting to CEF. The extra native headroom matters: Bun can consume a reply
and submit replacement work before CEF destroys the acknowledged task. Native
capacity rejection returns an explicit error for that unposted request, without
executing it or shutting down unrelated resources. Actual protocol errors and
output-channel failures retain the existing fail-closed behavior. A reference-counted permit belongs to the task; it is released only
when its final CEF reference is destroyed, including failed posts and discarded
tasks that never execute. High-water and current counts are exposed through
`commandAdmission` diagnostics. `pending` excludes the executing diagnostics task.

Native accounting bounds retained **wire-equivalent input**, not exact Rust heap,
CEF buffers or process RSS. Parsing can additionally own one bounded incoming
frame; CEF operations and renderer deliveries have their separate existing limits.
The native-to-Bun event queue is not changed by this increment.

Request IDs and wire/dispatch ordering remain unchanged. Cleanup is admitted
behind existing work; it does not overtake side effects whose ordering matters.
These limits do not preempt a blocked syscall or synchronous callback, guarantee
wall-clock latency, reserve renderer transport capacity, or implement global
view fairness. No polling, extra worker, native deadline change or security
exception is introduced. Those remaining scheduling/load requirements stay in #26/#27.

## Qualification

Deterministic Bun tests saturate count and byte budgets, then admit cleanup;
exercise cancellation, late/out-of-order replies, reentrant serialization, large
control arguments, exact operation spelling, failed writes and blocked adapters.
Rust tests cover shared policy, bounds, concurrency, cloned permits, rejected
admission, repeated release, and an actual CEF task-wrapper clone/discard lifetime.

The maintained real CEF fixture creates an ephemeral session, submits 96 ordinary
diagnostics in one JavaScript turn, requires ordinary request 97 to reject, and
submits real session disposal through the reserved capacity before yielding.
A transport-side counter must independently record the control admission while
all 96 ordinary slots are still occupied; merely requesting disposal in the same
async function does not prove that condition. All 96 native snapshots must still see the session, proving FIFO preservation;
disposal must complete and the subsequent snapshot must have zero sessions and
only its own command reservation. The schema-5 native RPC receipt requires this
case in each of the five normal launches. Older schema-4 receipts do not qualify
this increment; historical evidence is not rewritten.

This functional case proves request-slot admission and actual native disposal.
Deterministic production-component tests supply byte-saturation and CEF-task
lifetime coverage; it is not a claim of a paused native UI or physical interaction
latency under terminal load. M5 native streams, terminal ownership, descendant
supervision and graphical load qualification remain open. Passing shutdowns do
not establish a causal fix for the historical intermittent CEF teardown failure.
