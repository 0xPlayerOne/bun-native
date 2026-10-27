# Cached development hosts and independent edits

Issue #32 adds two executable operations: content-addressed prepared-host reuse,
and a bounded application edit loop. The native desktop owner remains stable;
only the supported application generation is replaced. The implementation uses
pinned Bun 1.4.3 for bundling and the selected generation broker for lifecycle
transitions. It adds no resolver, dependency manager, native compiler invocation,
or per-service process.

## Prepared host cache

`prepareDevelopmentHost` accepts the selected native ABI, engine version, target,
Bun version, application identity, host configuration, and a trusted inventory of
runtime inputs. Each inventory item names an actual local file and its expected
SHA-256. The cache streams and hashes those files before use; a version label or
mtime does not establish identity. Input paths are hashed into the key because an
assembled bootstrap may reference a verified artifact in place. Moving that
artifact invalidates such a reference.

Host configuration is bounded JSON and is canonicalized before hashing. It must
include origins, permission policy and stable bootstrap configuration. Ordinary
application service sources belong to the generation bundle and do not enter the
native host cache key. Changing the ABI, engine, Bun, app identity, selected bytes
or host configuration selects another prepared host.

The caller's `assemble(directory, signal)` callback runs only on a cache miss. It
assembles already acquired artifacts and returns a relative entrypoint. Existing
authenticated CEF acquisition remains responsible for validating its complete
runtime inventory; a manifest file's hash alone does not prove the files it names.
The development cache is not a second acquisition path or a new trust root.

Assembly uses a private staging directory, an exclusive per-key lock, and atomic
publication. The native input identities are checked again before publication.
Every prepared file, directory and contained relative symlink is inventoried;
reuse compares that complete inventory, including file bytes and executable modes
where supported. Corruption or an extra file fails closed instead of silently
reassembling over an in-use host. A stale lock is not removed automatically.

Simultaneous instances may share an immutable prepared host. Each instance owns a
different mutable directory for generated code and, when the launcher chooses,
browser profile data. An already owned instance identifier fails explicitly.
Cache roots must be private owned directories; this is not a defense against a
hostile process running as the same user and racing filesystem operations.

## Application edit loop

`DevelopmentSession.start` belongs in the stable desktop owner. Supply its source
roots and connect its callbacks to the production generation broker:

```ts
const development = await DevelopmentSession.start({
  projectRoot,
  entrypoint: 'backend/main.ts',
  backendRoots: ['backend'],
  frontendRoots: ['frontend'],
  sharedRoots: ['shared'],
  generatedRoots: ['generated'],
  cacheRoot: '.bunly/development',
  configurationFile: 'bunly.config.json',
  restartFiles: ['stable-bootstrap.ts'],
  frontendOrigin: 'http://127.0.0.1:5173',
  reload: ({ entry }) => serviceHost.reload({ entry }),
  shutdown: () => serviceHost.close(),
  onDiagnostic: (event) => console.log(JSON.stringify(event)),
})
```

The runtime and CLI packages retain their dependency boundary. The application
owns this wiring; the CLI edit loop receives narrow callbacks rather than a native
identity object or authority-bearing runtime import. The `reload` callback may
revalidate and supply concrete resource attachments before calling the broker.

Each backend edit uses `Bun.build` with the native Bun resolver, a fresh immutable
generation directory, bundled dependencies, and linked source maps. Unresolved
dynamic imports are rejected rather than accidentally loading stale paths later.
Bun's actual build metafile supplies the dependency graph; imported files outside
declared source roots receive filesystem observation too. Declared roots are
watched recursively for new/deleted/shared/generated files. Sources and the cache
must occupy separate roots so generated bundles cannot trigger a rebuild loop.

| Changed input                                                                                                    | Behavior                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Backend source or an imported dependency                                                                         | Bundle a candidate, invoke transactional reload, retain the old generation on ordinary failure |
| Frontend source                                                                                                  | Notify optional frontend integration; its existing tooling owns HMR                            |
| Shared module or declared generated source                                                                       | Backend replacement and frontend notification in one serialized batch                          |
| Host JSON, package manifest, lockfile, Bun configuration, TypeScript configuration, declared stable/native input | Require a full restart and explain that resource persistence is lost                           |
| Broken host JSON                                                                                                 | Report configuration failure and leave the serving generation usable                           |
| Watcher failure, unknown-path notification, or capacity overflow                                                 | Require restart instead of silently dropping changes                                           |

Configuration fingerprints are checked at batch admission and again before
publishing a backend candidate. A pending frontend/backend event therefore cannot
hide a simultaneous host configuration edit. A full restart must reconstruct the
session with the new configuration; the running session never adopts new native
or permission settings implicitly.

Finite batches are coalesced, not replayed as mutations. There is at most one
transition plus one pending set, at most 64 pending callers, a default 1,024-path
change bound and a default 4,096-dependency bound. Every accepted explicit
invalidation caller receives a result or rejection. Watchers use filesystem
notifications; there is no permanent source polling loop.

The callback contract requires `reload` to resolve only after old-generation exit
and cleanup are confirmed. Ordinary rejected candidates identify
`candidateRetired: true`. Missing cleanup confirmation, a committed failure, or
`restartRequired: true` preserves both old/new artifacts, halts further edits and
requires controlled recovery. It never deletes live code or silently retries a
mutation. The production `ServiceReloadHost` provides these receipts. A custom
adapter must provide equivalent guarantees.

The supplied `reload`, `frontendChanged`, `shutdown` and cold `assemble` callbacks
are trusted stable-host code. They must bound their own I/O, honor supplied abort
signals, and settle after their owned work has stopped. `shutdown` receives no
signal and must enforce its own finite cleanup deadline. The session cannot
safely interrupt an uncooperative in-process callback or claim that its work has
stopped merely because a timer expired. The production generation broker bounds
its prepare, quiesce, retirement and exit stages independently.

On successful replacement the prior bundle and its map are removed. Failed
preparation removes only the confirmed retired candidate. `close()` closes
watchers, rejects queued work, aborts the session signal, calls the owned runtime's
shutdown, waits for the active transition, and removes the instance directory only
after cleanup succeeds. Uncertain shutdown retains that directory and returns an
error. The shared prepared host remains reusable.

## Frontend tooling and diagnostics

The optional frontend origin is an exact numeric-loopback HTTP origin with an
explicit port. Startup probes the existing server without following redirects;
unavailable servers fail with `FRONTEND_UNAVAILABLE`. The session does not start,
kill, proxy or replace the user's frontend process or its HMR connection. No
framework-specific frontend dependency is required.

A frontend event reports `frontendNotified: true` only after the configured
`frontendChanged` callback acknowledges it. Without a callback the event is still
observed and classified, but the result explicitly leaves notification false;
the external tool owns any actual HMR update. A callback receipt alone does not
prove that a browser applied the edited source.

An optional diagnostic port binds read-only status on `127.0.0.1`. A requested
occupied port fails with `PORT_IN_USE`; there is no silent change to another port.
Port zero explicitly requests an ephemeral port for parallel instances. The sole
endpoint is `GET /__bunly/health`; it exposes bounded counters, no reload command,
native identity, filesystem path, code, payload or credential. CLI integrations
may instead consume only structured diagnostic callbacks.

Diagnostics have a schema version, sequence, stage, elapsed duration, stable code,
restart disposition and explanation. Build errors include source file/line/column;
linked maps let the generation broker report original application stack locations.
Those detailed local errors are developer diagnostics, not sanitized public
benchmark evidence. Diagnostic observer exceptions cannot roll back a committed
transition.

## Validation and limits

```sh
bun test tests/dev-host.test.ts tests/dev-host-runtime.test.ts
```

The tests exercise actual fresh Bun Workers and the production Worker/process
broker, changed imported and generated code, source-mapped initialization errors,
syntax failures, independent frontend events, real filesystem notifications,
parallel cache writers/instances, occupied loopback ports, an externally owned
frontend server, changed/corrupt native input identity, and cleanup uncertainty.
They check that a warmed source edit calls no assembly path and leaves one live
generation bundle. Portable adapter fixtures are not native desktop certification.

The supplied assembler is trusted host code and must use existing verified
artifacts; the cache cannot prevent arbitrary callback side effects. No native
compilation is available in the maintained edit loop. Actual platform filesystem/
process tracing and the native 500-replacement soak are recorded separately by
the integrated qualification. Missing a source root for files read dynamically by
application code cannot be inferred from a JavaScript import graph: declare such
generated assets and configuration explicitly. Native addons, owner bootstrap
changes, arbitrary unmanaged closures and irreversible external effects remain
outside the resource-preserving reload contract.
