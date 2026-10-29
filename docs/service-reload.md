# Transactional application generations

`ServiceReloadHost` implements issue #30 on top of the accepted
[managed ownership model](managed-generations.md) and
[mechanism qualification](reload-mechanism-qualification.md). The existing
supervised Bun desktop process retains the native connection, resources, terminal
leases and renderer streams. A single replaceable Bun Worker runs application
handlers. One candidate can prepare beside the serving Worker; there is no
Worker or process per ordinary service.

This is a trusted-code lifecycle boundary. It is not a security sandbox, native
addon crash containment, arbitrary side-effect rollback, or a remedy for the
independent CEF teardown investigation.

## Application module

An application entry exports one initialization function. It returns a schema,
an optional bounded JSON state snapshot and a bounded collection of handlers:

```ts
import type { ServiceApplication } from '@bunly/runtime'

const application: ServiceApplication = (context) => ({
  schema: 'application:1',
  state: context.state ?? '{"counter":0}',
  handlers: {
    greeting: async (input, call) => {
      call.signal.throwIfAborted()
      const request = JSON.parse(input)
      return JSON.stringify({ greeting: `Hello ${request.name}` })
    },
    resize: (input) => context.invoke('workspace', 'resize', input),
  },
})
export default application
```

Inputs, outputs and transferred state are JSON **strings** with UTF-8 byte
limits. The application cannot receive the native backend, `ManagedResource`
identity objects, a `PolicyScope`, or the stable host itself. Resource names are
resolved through the actual sending isolate and that generation's host-owned
attachment map. Supplying a copied identifier does not create authority.

`context.handle(name, handler)` supports initialization-time registration; a name
already registered there cannot also appear in the returned handlers. Readiness
requires at least one valid handler and the exact declared state schema.
Initializing application code may read its transferred snapshot and register
cleanup. It cannot invoke native resources before publication.

Reserve disposable work before installing it:

```ts
let timer: ReturnType<typeof setInterval> | undefined
context.own(() => clearInterval(timer))
timer = setInterval(() => { /* generation-local work */ }, 1000)
```

`own()` returns an explicit async release function. Cleanup executes once; a
rejected cleanup is retained as a failure. An optional definition `dispose()` is
also registered. Final Worker termination stops its runtime timers/listeners;
the framework cannot infer that an arbitrary external side effect was reversed.

## Stable owner setup

```ts
const host = new ServiceReloadHost({
  owner,
  stateSchema: 'application:1',
  permissions: ['workspace'],
  resources: await desktop.prepare(),
  onDiagnostic: (event) => writeDeveloperDiagnostic(event),
})

await host.reload({ entry: absoluteFreshlyBundledEntry })
const output = await host.request('greeting', JSON.stringify({ name: 'Ada' }))
```

Concrete native adapters register resources with `ManagedGenerationOwner` and
return `{resource, schema}` attachment records. Native adapters should additionally
provide host-only `validate` and `current` hooks. `validate` performs a fresh,
read-only asynchronous native authority check after candidate readiness.
`current` checks the current document and policy synchronously immediately before
commit. Timed-out validation remains charged until its actual settlement.
Every subsequent operation still passes the adapter's current authorization;
attachment validation never grants indefinite authority.

`reload({entry, resources})` accepts a new trusted map to account for closed views
or changed attachment policy. A closed staged resource invalidates its candidate;
it is not silently removed to make the commit pass. State transfer is explicit:
pass `state` to reload or return a new state snapshot from initialization. It does
not serialize live globals, arbitrary closures or a changing application heap.

Register `CefBackend.serveRpc()` and `serveStreams()` once in the stable owner.
RPC handlers forward through `host.request()`, with existing native-bound RPC
validation and capabilities. Keep terminal output streams and their backpressure
in the stable owner so a handler replacement does not interrupt terminal output.
`dispatchEvent()` uses the same bounded, acknowledged handler path as `request()`;
callers must handle transition rejection or apply their own bounded event queue.
It never silently drops or replays an event.

## Transition and failure semantics

| Stage    | Behavior                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prepare  | Start a fresh application-generation isolate and wait for bounded readiness. The previous generation continues serving.                                                              |
| Validate | Validate bounded handler/state declarations and fresh attachment authority. Syntax, import, initialization, schema and registration failures preserve the old serving generation.    |
| Quiesce  | Reject new dispatch with `QUIESCING`; settle accepted old callers with `RETIRED` and deliver their abort signals. Wait a finite interval for actual stable-owner adapter settlement. |
| Commit   | Perform final synchronous attachment checks, publish through the managed owner and switch the whole route set. Native resources are retained.                                        |
| Retire   | Run cleanup, terminate the old isolate, and observe actual exit before successful reload returns.                                                                                    |
| Failure  | Emit a structured stage/code and bounded source-mapped diagnostic. Keep reservations for unknown or failed work; require explicit recovery where rollback is unsafe.                 |

A cancelled caller is not proof that its handler or native adapter has stopped.
Request slots remain charged until an actual reply or generation exit. Native
adapter reservations follow the ownership model until actual underlying
settlement even after the caller has already rejected or the Worker has exited.
The bounded `owner.whenIdle(signal)` observer wakes on actual adapter settlement,
including settlement after an earlier resource-close cancellation; it does not
poll or confuse caller rejection with completed native work.
If a native operation cannot quiesce, the candidate is abandoned and the old
generation remains defined; the error requires controlled restart instead of
pretending the uncertain mutation was undone. A later explicit reload can be
attempted after actual adapter settlement. Mutations are never replayed
automatically.

Handler invocation context crosses asynchronous continuations through the
generation-local `AsyncLocalStorage`. A timed-out/cancelled handler cannot make
another managed native invocation merely because its old generation is still
serving other calls. This does not prevent arbitrary unmanaged application code
from mutating external systems; those effects remain outside the contract.

Unexpected runtime exceptions or generation exit explicitly settle accepted
requests and revoke that generation. A new generation can be prepared explicitly.
If an old disposer fails after publication, the new handler generation remains
the serving generation, while the reload rejects with `committed: true` and
`restartRequired: true`. No automatic attempt restores a generation whose code
or external effects have already been retired.

`ServiceReloadError.candidateRetired` tells the dev runner whether candidate
artifact files are safe to discard. Successful reload returns only after the
previous generation's observed exit. Unconfirmed retirement or a failure after
publication requires retaining the old/new artifacts and an explicit restart.
`close()` revokes and reaps generations; it does not dispose the stable desktop
resources. Their owner performs dependency-ordered shutdown afterward.

## Bounds, diagnostics and packaging

Defaults are 64 pending requests/resource calls per generation, 128 handlers,
256 cleanup registrations, 64 KiB JSON snapshots and 512 KiB framed messages.
The managed owner's aggregate limits also apply. Cancelled requests and failed
cleanup do not create free admission. Concurrent reload requests are rejected
with `BUSY`; file watchers can coalesce edits before calling the host.

Readiness defaults to five seconds, quiescence to two, cleanup grace to one,
observed exit to two and handler requests to ten. These are explicit finite
orchestration deadlines, configurable within bounds; they do not change CEF's
watchdog or native shutdown policy. A synchronous application loop can force
generation termination while preserving the stable owner. Such termination is
reported, not described as completion of application-defined external cleanup.

Generation stdout/stderr are consumed separately from native protocol stdout,
counted and bounded to 1 MiB per generation. They are not forwarded into the
native pipe or retained in diagnostics. Applications requiring continuous logs
should use an explicitly managed log adapter. Failure diagnostics include a
bounded source-mapped stack for local developer use; redact private paths and
application messages before publishing evidence. Diagnostic callback failures
cannot alter lifecycle admission.

The normal built SDK ships its runner beside the runtime bundle and selects the
adjacent `.js` entry automatically; source execution selects the `.ts` entry.
When creating a custom single-file stable-host bundle, also build
`packages/runtime/src/service-reload-runner.ts` as a separate Bun entry and pass
its absolute location as the `runner` option. Application modules should use
immutable bundle paths with linked/inline source maps; normal `Bun.build` handles
their dependency graph. No custom resolver, undocumented Bun embedding API,
native compilation, or native resource copy occurs inside reload.

`mechanism: 'process'` preselects one supervised application-generation Bun
subprocess using private IPC with the same protocol and exit gates. It is not an
automatic fallback after executing code on the stable owner's event loop.
Generation code must create long-lived child processes through managed owner
adapters; detached unmanaged descendants are outside this supported fallback.
Replacing the stable desktop process itself is a full restart and loses resource
persistence.

## Verification and scope

Run `bun test tests/service-reload.test.ts` with pinned Bun 1.4.4. The suite uses
actual Workers and subprocesses, changing dependency sources, loopback listeners,
syntax/import/init failures, blocked synchronous code, pending requests, unsettled
host adapters, late continuations, authority revocation, failed disposal and
shutdown races. Process IPC and loopback tests require an execution environment
that allows those local operations. A restricted sandbox that prevents IPC is a
failed/unavailable test environment, not a Bun compatibility result.

These tests establish the implemented broker transitions. They do not replace
issue #31's actual native reconnection, #32's warmed filesystem/process proof,
or #33's 500-replacement desktop soak and pinned competitor comparison.

The subprocess mechanism uses the documented
[Bun IPC API](https://bun.sh/docs/runtime/child-process#inter-process-communication-ipc);
its actual behavior is tested on the pinned executable rather than inferred from
current documentation alone.
