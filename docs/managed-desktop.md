# Retaining desktop resources across service replacements

`ManagedDesktopResources` is the concrete adapter for issue #31. The stable Bun
host retains existing `CefBackend` windows, views and sessions, `TerminalService`
terminals, and `ServiceSupervisor` instances. Replacement application code gets
named operations through `ServiceReloadHost`, never the native handles or the
owner itself. This extends the [managed generation contract](managed-generations.md).

Registration is explicit. A replacement does not recreate a window, navigate a
view, create a session, spawn a terminal, or restart a supervised child. Existing
browser form, navigation and session state stay in the same native objects.
Application-service state is a separate, bounded JSON snapshot with an exact
schema label; it is not a serialization of browser state or arbitrary globals.

## Stable-host setup

Create and register resources in the stable host, outside the replaceable
application entry. Capture authority from the current trusted application view
after its initial document is ready.

Renderer transport grants can arrive before native `OnLoadEnd`. Wait for the
native `view.loaded` receipt matching the view's current document and URL, along
with the application's own readiness signal, before capturing authority. Subscribe
before creating the view so an early receipt is retained, and cancel the wait and
subscription through the application's startup deadline. The maintained
[fixture barrier](../examples/managed-desktop/document-readiness.ts) demonstrates
this ordering; `captureAuthority` still performs the native policy check afterward.

The following assumes `backend`, `window`, `view`, `session`, `terminalService`,
and `terminalHandle` are already live:

```ts
import { ManagedGenerationOwner } from '../packages/runtime/src/managed-generations.ts'
import { ManagedDesktopResources } from '../packages/runtime/src/managed-desktop.ts'
import { ServiceReloadHost } from '../packages/runtime/src/service-reload.ts'

const owner = new ManagedGenerationOwner()
const desktop = new ManagedDesktopResources(owner, backend)
const authority = await desktop.captureAuthority(view)
let workspaceAllowed = true
const policy = (operations: readonly string[]) => ({
  authority,
  permission: 'workspace',
  operations,
  authorize: () => workspaceAllowed,
})

const retainedSession = desktop.registerSession(
  'session', session, policy(['identity', 'flush'])
)
const retainedWindow = desktop.registerWindow(
  'window', window, policy(['state', 'show'])
)
const retainedView = desktop.registerView('view', view, {
  ...policy(['state', 'focus']),
  dependsOn: [retainedSession, retainedWindow],
})
desktop.registerTerminal('terminal', terminalService, terminalHandle, {
  ...policy(['identity', 'write', 'resize']),
  dependsOn: [retainedView],
})

const services = new ServiceReloadHost({
  owner,
  stateSchema: 'workspace:1',
  permissions: ['workspace'],
  resources: await desktop.prepare(),
  initialState: JSON.stringify({ revision: 1 }),
})

// entry is an absolute path to a prepared application bundle.
await services.reload({ entry, resources: await desktop.prepare() })
const result = await services.request('terminalInput', JSON.stringify({ text: 'hello\n' }))

// After the development coordinator builds a later version:
await services.reload({ entry: nextEntry, resources: await desktop.prepare() })

// Revocation applies to later attachment checks and operations.
workspaceAllowed = false

// Final application shutdown, not ordinary handler replacement:
await services.close()
await desktop.dispose()
owner.dispose()
```

The application bundle exports the service factory expected by
`ServiceReloadHost`:

```ts
import type { ServiceApplication } from '../packages/runtime/src/service-reload.ts'

const application: ServiceApplication = (context) => ({
  schema: 'workspace:1',
  state: context.state ?? JSON.stringify({ revision: 1 }),
  handlers: {
    terminalInput: (input) => context.invoke('terminal', 'write', input),
    windowState: () => context.invoke('window', 'state', 'null'),
  },
})
export default application
```

Resource names are host-selected labels, not authority. The broker binds a request
to its actual Worker or process, application generation, and the host's resource
map. A copied token, invented native ID, extra `pid` argument, retired generation,
or an operation omitted from the allowlist cannot acquire the resource. Register
each underlying resource once in a registry; aliases of the same handle are
rejected. The host must supply live handles it owns.

## Authority and replacement checks

`captureAuthority(view)` creates an opaque host-only token. It requires an
application-trusted view and retains the exact native view, session, document,
frame, navigation generation, and origin scope. Tokens cannot be copied between
registries. No token or native policy scope is sent to replacement code.

The host explicitly delegates a required permission label and an operation
allowlist for each resource. An optional `authorize(operation)` callback can
recheck changing application policy; it also receives `attach` during preparation.
It must be synchronous, side-effect-free, and return literal `true` to permit
access. A promise or thrown exception denies access. This host callback is
separate from browser OS-permission grants.

Attachment and operation validation have complementary checks:

1. `prepare(names?)` validates the selected entries against current host policy,
   current TypeScript document identity, and a fresh native `policy.scope` read.
   It rejects closed or stale resources and returns immutable bindings.
2. Each binding includes host-only `validate` and `current` functions. The service
   host repeats asynchronous native validation after candidate readiness and
   performs the final synchronous policy/document checks after quiescence, before
   commit. Keep these functions when passing bindings to `ServiceReloadHost`;
   copying only `{ resource, schema }` discards those replacement checks.
3. `ManagedGenerationOwner` checks exact resource/schema identity and the
   generation's permissions. Every operation rechecks policy and document identity,
   awaits fresh native scope validation, and rechecks generation, attachment,
   cancellation, and policy before dispatch. Retirement during that native lookup
   cannot dispatch a later side effect.
4. Results are rechecked before delivery. A cancelled caller does not prove a
   dispatched native effect was undone. The owner keeps outstanding adapter work
   charged until it actually settles; cutover cannot overlap unresolved work.

`CefBackend.validatePolicyScope` validates native identity without granting or
performing a new OS action. These adapters expose only the existing backend,
terminal, and supervisor operations listed below. They do not call
`authorizeNativeOperation` and interpret its M7 `unavailable` result as success.
File access, clipboard, external URL launch, and other absent M7 adapters remain
unavailable. Browser permission policy and native document revocation are unchanged.

Navigating or replacing the authority document invalidates its captured bindings.
The adapter never silently refreshes authority to a new document. The stable host
must explicitly rebuild the authorized registration plan or perform a controlled
full restart. A native page reload can revoke existing document-bound RPC and
stream connections; backend-service replacement does not override that lifecycle.
These checks guard cooperative managed code, not arbitrary malicious Bun code or
same-process native addons.

## Operations

Every input and result is a JSON string. Empty input means the string `null`.
Object inputs must have exactly the listed keys. Native/backend validation still
applies after adapter validation.

| Resource           | Schema             | Operations and inputs                                                                                                                                                     |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window             | `bunly.window:1`   | `state`, `activate`, `minimize`, `restore`: `null`; `show`: `{ "visible": boolean }`; `resize`: `{ "width": integer, "height": integer }`, each 1–16,384                  |
| View               | `bunly.view:1`     | `state`, `focus`: `null`; `navigate`: `{ "url": string }`, at most 8,192 characters                                                                                       |
| Session            | `bunly.session:1`  | `identity`, `cookies`, `flush`: `null`                                                                                                                                    |
| Terminal           | `bunly.terminal:1` | `identity`: `null`; `write`: `{ "text": string }`, 1–16,384 UTF-8 bytes; `resize`: `{ "cols": integer, "rows": integer }`, each 1–1,000; `signal`: `{ "signal": string }` |
| Process supervisor | `bunly.process:1`  | `state`: `null`; `write`, `resize`, `signal`: the same inputs as terminal operations, addressed to the supervisor's current ready attempt                                 |

Signal names are restricted to `SIGHUP`, `SIGINT`, `SIGQUIT`, `SIGTERM`, `SIGKILL`,
`SIGUSR1`, `SIGUSR2`, and `SIGWINCH`. Signalling does not authorize a fresh child.
Supervisor operations use its actual attempt identity; the returned attempt number
is diagnostic only. An application generation and a supervisor child attempt are
different lifetimes. The adapter does not change a supervisor's explicit restart
policy.

Identity operations return diagnostic public IDs. View and window state operations
return their existing backend state. The supervisor returns its snapshot with a
diagnostic attempt number. Mutation acknowledgements are `null`, except existing
window activation/minimization/restoration methods which return window state.
There is no managed spawn operation or implicit replacement of a failed resource.

## Lifecycle events and terminal output

One stable backend listener serves the registry. Reloading application code adds
no new backend listener. Window, view, and session policies may opt into `events`
and `ack-events`; these expose a bounded pull journal of their native lifecycle
events. A native `disposed` event immediately closes the managed resource and
invalidates staged replacements instead of waiting for application delivery.

`events` accepts `null` and returns a snapshot of unacknowledged records:

```json
[{ "sequence": 1, "type": "navigated", "state": { "documentId": "…" } }]
```

The actual state includes the full backend view state. After processing the
snapshot, `ack-events` takes `{ "through": lastSequence }`. The sequence must match
the latest nonempty snapshot read by the same active generation. An old generation
cannot acknowledge a new generation's records. Reading does not acknowledge or
automatically deliver a callback; retain the sequence in application processing
when deduplication matters.

There is no automatic replay after a failed handler. A replacement may explicitly
read still-unacknowledged records. If the previous handler performed an external
effect and retired before acknowledgement, that effect is uncertain; the journal
does not promise exactly-once external mutations. Handle records idempotently or
reconcile state before retrying. `ServiceReloadHost.dispatchEvent` provides the
same bounded, acknowledged request path as `request` for host-selected event
handlers. Route lifecycle handling through it rather than retaining a closure
from a retired service.

The default per-resource journal holds at most 64 records and 32,768 encoded record
bytes. Constructor options `maxEvents` and `maxEventBytes` allow up to 1,024 records
and 65,536 bytes; the owner's JSON output cap also applies. Overflow latches and
subsequent reads fail with `CAPACITY`. It does not silently drop old records and
report a complete history. Diagnose the overflow and explicitly reconcile or
restart. No journal growth or automatic callback replay follows overflow.

PTY output does not pass through the lifecycle journal or a disposable application
Worker. Its original `TerminalService` writer, stream credit, consumer, and native
lease remain in the stable host. Handler replacement changes who may send input;
it neither resubscribes the output source nor restarts the child. Existing terminal
output limits and backpressure remain active. A stalled consumer is still a real
stream failure, not permission to buffer indefinitely. Registering a terminal or
supervisor does not install a second application output listener.

## Closure and recovery

Declare resource dependencies explicitly: views depend on their window and session;
view-owned terminals depend on that view. `desktop.dispose()` marks all entries
closed, removes the one native listener, and awaits dependency-ordered actual
cleanup. `close(name)` closes a selected resource; closing a parent waits for its
still-live dependents, so close those first or dispose the whole registry.

Native resource closure during candidate preparation invalidates the candidate.
A terminal exit revokes its managed attachment immediately while waiting for its
final output, native terminal closure, and actual `TerminalService` release. Normal
exit does not cancel remaining output merely to make cleanup appear complete.
Closing a registered supervisor waits for its actual settlement and rejects
unreleased child ownership. Cleanup failure remains charged in the generation
owner; no replacement resource is silently created to hide it.

Ordinary imperative applications, changed native ownership, incompatible state or
resource schemas, an authority-document change, unmanaged listener or timer
effects, unobserved cleanup, and unsupported native-addon replacement require an
explicit migration or full restart. Owner-process death still terminates native
terminal leases. A controlled restart may lose in-memory form/process state; report
that fact to the developer instead of claiming persistence.

## Validation

```sh
bun test tests/managed-desktop.test.ts tests/cef-backend.test.ts
bun test tests/managed-generations.test.ts tests/service-reload.test.ts
bun run typecheck
bun run typecheck:browser
bun run boundaries
```

The adapter suite exercises retained native-handle identities against a real
`NativeTransport` with a fake CEF protocol peer, changing document scopes and
permissions, closure during preparation, bounded lifecycle journals, stale
generation rejection, and supervisor ownership. It also launches an actual Bun
PTY child and validates numbered Unicode output through repeated managed
reattachment with the existing xterm qualification consumer, one child launch,
and actual terminal release. The fake CEF peer is not a rendered desktop test, and
ownership transitions alone are not #33's application-module reload soak.

The native desktop example and qualification must separately establish retained
CEF form/navigation/session state, real application-handler replacement, output
continuity and bounded growth on the supported platform. These portable adapter
tests do not close #124's native watchdog investigation or qualify missing M7 OS
features.
