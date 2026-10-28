# Managed resources and application generations

**Issue:** #28. **Status:** executable ownership contract and portable model.
This is not a module loader, native resource-reconnection implementation, completed
backend-reload feature, or security sandbox. #29 qualifies the replacement
mechanism; #30 adds prepare/readiness/quiesce/commit orchestration; #31 integrates
native adapters; #32/#33 add the development host and actual reload soak.

The integrated implementations are documented in [service reload](service-reload.md),
[managed desktop resources](managed-desktop.md) and [development hosts](development-host.md).
The model and validation limits below describe the ownership primitive itself;
native desktop acceptance is a separate workload using those implementations.

## Stable owner versus replaceable code

The supervised Bun host remains alive and owns `CefBackend`, `TerminalService`,
native process leases, and managed resource adapters. Replacing application-service
code must not replace that host. The current native terminal leases intentionally
stop children when the owning Bun process disappears. Merely spawning a new backend
therefore cannot preserve existing terminals.

| Lifetime                  | Owns                                                                                                       | Retirement                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Stable runtime            | Windows, views, sessions, terminal/process leases, native authorization adapters and resource dependencies | Explicit resource close or final owner shutdown; actual release is required                             |
| Application generation    | Handler registrations, listeners, timers, framework requests, and explicitly managed disposable state      | Immediate revocation, then tracked cleanup; failures remain charged                                     |
| Native document authority | Frame/document/session identity and granted capabilities                                                   | Existing navigation, view close and permission policy; a managed attachment never replaces those checks |

`ServiceSupervisor` generations are fresh application-child restart attempts.
`ManagedGenerationOwner` generations are application-service ownership epochs.
They are different contracts, not two interchangeable supervisors. This model adds
no thread, process, Worker, polling loop, or separate terminal transport.

Ordinary imperative TypeScript remains supported. Code that does not opt into
managed ownership requires a documented full restart rather than an invented
resource-preserving reload. Managed resources are opt-in, not inferred from arbitrary
objects, file descriptors, closures, or module exports.

## Host and service APIs

The stable host creates `ManagedGenerationOwner` and retains it privately. It
registers owner-side adapters with `register`, starts a candidate with `begin`,
attaches exact resource identities with `attach`, and publishes it with `commit`.
`scope(generation)` returns the frozen, restricted application facade:

```ts
const candidate = owner.begin('app-state:1', ['view:read'])
owner.attach(candidate, registeredView, 'view:1')
const scope = owner.scope(candidate)
const previousState = scope.state() // immutable bounded JSON, or undefined
// Validate candidate implementation/readiness outside this ownership model.
owner.commit(candidate, JSON.stringify({ revision: 2 }))
const result = await scope.invoke(registeredView, 'state', 'null')
```

The facade has only `generation`, `signal`, `state`, `invoke`, `own`, `release`, and
`callback`. It cannot register resources, grant permissions, attach handles, commit
itself, retry failed native cleanup, or dispose the owner. Give it only the resource
identities explicitly selected by the host. All identities are frozen, opaque
objects checked by identity equality. Copied, wrong-kind, foreign and retired
identities cannot address live ownership; there is no caller-provided numeric PID
or string ID used as authority. These are in-process identities, not IPC tokens.

Adapters declare resource kind (`window`, `view`, `session`, `terminal`, or
`process`), an exact schema label, a required permission label, a synchronous
`authorize`, an `invoke`, and a retry-safe `dispose`. Registration snapshots the
methods. Labels are at most 128 characters; at most 64 permission labels are
admitted per generation. A permission label is only a prerequisite: `authorize`
must validate the **current** native document/capability scope for each operation.
Only literal `true` permits execution. A mistakenly asynchronous authorizer is
denied; its rejection is observed, never promoted into an authorization result.

The adapter boundary uses immutable JSON strings. Inputs, outputs and transferred
state are validated and UTF-8 byte-bounded before parsing/acceptance. Raw native
handles do not cross that boundary. The owner cannot stop a faulty adapter from
allocating an oversized output before returning it, and this is not a same-process
malicious-code defense. Native operation parsers, permissions, and byte limits
remain mandatory in the concrete adapter.

## State, attachment and cutover contract

Only one candidate and one active generation may exist. Retired generations can
remain counted while their underlying operations or cleanup are unsettled.
Preparing code may read compatible transferred state and register its own cleanup;
it cannot invoke stable resources or receive active callbacks.

`commit` checks valid bounded JSON, the exact state schema, every staged attachment,
and absence of unresolved adapter invocations. It validates before publishing, with
no user callbacks in between. It publishes the new active generation and state,
then revokes the old one before running cleanup. Reentrant abort callbacks may close
the newly published generation; the commit path never resurrects it afterward.

State is explicitly provided by the stable coordinator. It is not a snapshot of
JavaScript globals or a serialization of arbitrary application closures. Matching
schema labels are necessary, not proof that a new application understands every
field. The coordinator validates application-specific content. Incompatible schemas
require an explicit migration/restart design; this increment never silently migrates
or rolls back external effects. The last snapshot survives generation retirement
until final owner disposal, allowing a compatible replacement to inspect it.

`retire(candidate)` abandons preparation without changing the previous active
snapshot or disposing stable resources. Closed resources invalidate a staged
candidate; removing its attachment afterward does not silently make that candidate
valid. Abandon it and prepare a new one. Live generation attachments to closed
resources are removed, not retained as unbounded tombstones. Detach/reattach uses a
fresh attachment epoch so a late result cannot become valid again by reattachment.

## Requests and late callbacks

Admission reserves a bounded work slot before scheduling the owner adapter.
Authorization and generation/attachment currency are rechecked before dispatch.
Adapters receive an abort signal and `isCurrent()` and must recheck after their own
asynchronous boundaries before managed side effects. Existing native authority
checks are still required; aborting a promise cannot undo an external mutation.

Retirement, detachment, or resource close immediately settles the framework caller
with `RETIRED` and aborts the operation signal. **It does not assert that the adapter
has finished.** Its reservation and resource-busy count remain until actual
settlement. A stuck adapter blocks cutover with `BUSY` and retains capacity, even
when its caller has already been cancelled. No automatic input/request replay or
uncertain retry is permitted. #30 must define finite orchestration deadlines and
controlled restart when it cannot safely quiesce; this model does not fabricate
release to meet a deadline.

Before installing a timer, listener or handler, reserve its cleanup with
`scope.own(kind, cleanup)`. Bind synchronous delivery through
`scope.callback(work, callback)`. A retired, preparing, released or foreign work
scope cannot deliver. Late delivery returns `false` without throwing through
`EventTarget`; admitted delivery returns `true`. Exceptions thrown by an admitted
application callback remain application failures, not an isolation guarantee.
The callback contract is synchronous (`() => undefined`); asynchronous continuation
code must re-enter checked scope operations. Arbitrary retained closures can still
mutate arbitrary shared globals and are outside managed authority.

Call `release(work)` to begin explicit cleanup, or retire the generation to begin
all its owned cleanup. Register removal for externally owned listeners, including
`process`/shared `EventTarget` subscriptions: closing a module graph alone is not
proof they disappeared. The owner tracks cleanup rather than globally monkeypatching
timers, promises, event emitters or the runtime.

## Cleanup, dependencies and bounded retention

Resource dependencies are declared at registration and must be existing live
resource identities. This forms an acyclic graph. A view can depend on its window
and session. Final disposal closes the dependent before its dependencies. Explicitly
closing a parent does not silently destroy its still-live dependents; it waits for
their release and refuses new dependents. A failed dependent retains its parents.
Actual child release wakes eligible parent cleanup without a polling timer.

A disposer resolves only after actual resource release. Throwing/rejecting cleanup
is recorded as `CLEANUP_FAILED`, keeps its capacity charged, and is never retried
implicitly. `retryFailed()` is stable-host authority and requires retry-safe
cleanup. A never-settling disposer remains pending. Repeated close calls share the
current completion; a previous failed promise stays failed even after a later
explicit retry succeeds. `dispose()` starts owner retirement; it does not claim
aggregate completion. Await known resource disposal promises and inspect remaining
ownership counters before declaring shutdown complete.

| Reservation                                                 | Default | Absolute configured maximum |
| ----------------------------------------------------------- | ------- | --------------------------- |
| Live resources, including closing/failed                    | 64      | 4,096                       |
| Active/candidate/retired-but-unsettled generations combined | 4       | 64                          |
| Generation work and active adapter calls combined           | 256     | 65,536                      |
| Bytes per state, input or output JSON snapshot              | 65,536  | 1,048,576                   |

These limits bound framework-admitted counts and snapshots, not a whole-process
memory budget or the memory retained by application closures. Attachments are
bounded by live resources times admitted generations. Disposed identity recognition
uses weak collections; there is no growing strong history. `diagnostics()` reports
resources, attachments, generations, work, active/candidate counts, in-flight calls,
failed cleanup and whether the owner is closed. It does not log payloads, native
identities, paths, credentials, or arbitrary error strings.

## Execution context and mechanism qualification

Create the owner in the stable host context, never inside a disposable
`Bun.ModuleGraph`. Owner operations and asynchronous cleanup use the host's captured
`AsyncLocalStorage.snapshot()` context. An application callback entering a managed
adapter must not accidentally make native resources children of the disposable
graph. A pinned-runtime regression creates a real loopback server through the
adapter from a graph, disposes that graph, verifies the stable server still answers,
and then closes it through the owner. That is a context-isolation test, **not**
a selected reload mechanism or native desktop persistence claim.

#29 must separately qualify documented APIs on the exact pinned Bun version.
Graph disposal does not settle every pending promise or guarantee that queued
microtasks/external listeners cannot run; the explicit ownership guards above
remain necessary. An isolate/process fallback must also keep the native owner and
its terminal leases outside the replaceable generation. No per-service Worker or
process fan-out is authorized by this design.

## Validation and limitations

Run the maintained model and focused tests:

```sh
bun run example:managed
bun test tests/managed-generations.test.ts
```

The example uses **MockBackend**, preserving its exact view/document object across
one handler-generation replacement and verifying stale listener suppression and
dependency-ordered disposal. Tests exercise ownership races, schema/permission
rejection, actual callback suppression, failed/late cleanup, underlying-operation
accounting and 500 **ownership-model** transitions. Those 500 transitions are not
#33's 500 actual desktop/backend replacements, memory soak, or performance evidence.

Unrestricted shell containment, module loading, readiness/rollback orchestration,
native reauthorization/reconnection, physical input, process-level fault recovery,
arbitrary side-effect reversal, native-addon replacement, and synchronous-hang
recovery remain explicitly unqualified here. Owner-process death still terminates
owned native work. #124's CEF watchdog investigation remains open; no native deadline,
security-cloning behavior, sandbox or provider policy changes in this increment.
