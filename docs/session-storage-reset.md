# Complete session storage reset

Explicit whole-profile clearing while the native host is stopped.

**Scope:** M4 persistent profile storage clearing and interruption recovery.
**Mode:** Offline, destructive, selected partition only.
**Boundary:** Not selective live clearing, secure overwrite or an OS credential-key reset.

## Public operation

A stopped application can clear every store in one persistent session profile:

```ts
import { resetPersistentSessionStorage } from '@bunly/runtime'

const result = await resetPersistentSessionStorage({
  hostExecutable: '/absolute/path/to/installed/native/host',
  persistentRoot: '/absolute/private/application/profile-root',
  partition: 'application-session',
  confirmation: 'delete-entire-profile',
})
```

Use the runtime package's actual workspace/import name for the installed SDK;
this example does not claim published package availability. The selected executable
must come from a trusted, already-installed runtime. The operation never downloads
or compiles native code, starts an application backend, or creates a browser view.
On Windows this is the packaged CEF sandbox bootstrap executable, not its DLL.
The existing root must already have a valid Bunly marker and normalized private
path. Unknown or missing profiles are rejected rather than guessed or created.

The result is an exact native success receipt identifying the requested partition,
complete storage/cookie/cache removal, and whether an interrupted reset was resumed.
Remaining inventory counts include framework markers and describe this invocation
only; a resumed invocation does not invent the number of bytes removed previously.
A timeout, cancellation, missing/duplicate receipt or nonzero native exit is not
successful clearing. The caller must inspect the failure and explicitly retry the
same operation to complete an interrupted reset.

The launcher requires maintenance protocol 1 in bounded installed runtime metadata
**before spawning**. An older runtime must not interpret unknown maintenance flags
as an ordinary application launch. Native configuration independently validates
that protocol. Malformed reset flags fail instead of falling through to normal
startup. The operation requires exact explicit deletion confirmation.

## Why offline

CEF does not expose a complete request-context API covering every HTML5 store.
Clearing only JavaScript localStorage or a list of first-party origins would leave
IndexedDB, CacheStorage, service workers or partitioned stores behind. Nor is it
safe to remove live Chromium databases merely because an application view closed.

The maintenance process acquires the same native kernel-held **root lock** as an
ordinary host. A live host keeps that lock through CEF shutdown, so reset fails
before mutation while any session in that root is active. The selected profile's
own lock is also held. This is a complete offline reset, not a hidden implementation
of `clearSession({ storage: true })` while a browser remains alive. The latter stays
explicitly unsupported; cookie/cache subset operations retain their existing live
contracts. To reset an ephemeral session, dispose its views/session and create a
new isolated session instead of persisting a temporary profile.

## Ownership and recovery

The logical partition maps to the same SHA-256 immediate-child profile directory
used by normal session creation. Root/profile markers, normalized containment,
private ownership and kernel locks are validated before deletion. The operation
never accepts an arbitrary relative deletion path and never scans/deletes the
whole profile root. A second partition and root-level application data remain.

A bounded preflight rejects symbolic links, reparse points, special files and
uninspectable data before ordinary deletion. POSIX file ownership/hard-link checks
are explicit; this is not a new claim of Windows ACL qualification. Inventory is
bounded to 65,536 entries, depth 64, 4,096 path units per entry and 16 MiB total
relative path units. Oversized profiles fail safely for deliberate maintenance;
no unbounded allocation is used. Logical-byte totals must remain exactly
representable in the TypeScript result.

After preflight, an exclusive durable reset-intent marker is written under the
private root. The selected profile is renamed to its deterministic quarantine.
The intent and quarantine names fence ordinary acquisition of that partition.
Data entries are removed while framework ownership metadata is retained; the
root lock stays held until the quarantine and intent are gone. An interruption
cannot silently reopen a partly cleared profile as if it were intact.

Retrying the same explicit operation resumes a valid intent/quarantine, including
an interruption after quarantine removal but before intent removal. Corrupt,
conflicting or unowned recovery state fails closed. A torn or corrupt marker
requires deliberate repair rather than guessing ownership. File/directory syncs
are used where supported, but full power-loss atomicity is not claimed. Failure
partway through removal is reported as incomplete; there is no rollback promise.

This is logical profile deletion, not cryptographic erasure or secure overwrite.
Backups, APFS snapshots, external credential stores and root-global browser state
are not erased. A hostile process already running as the same user can race private
filesystem changes; the maintenance API is not a sandbox against that adversary.
The API is runtime-only, not exposed by a renderer bridge or granted by a page ID.

## Native qualification

```sh
bun run qualify:cef-session-reset -- PREPARED_NATIVE_APP
```

The actual CEF fixture writes and verifies independent values in two persistent
profiles using localStorage, IndexedDB, CacheStorage and service-worker
registrations, then restarts to verify persistence. It proves a live-root reset
is rejected, deliberately interrupts deletion after quarantine, proves normal
reopening is fenced, resumes the reset, and verifies all four stores empty in the
selected profile while the other profile retains its own values. The selected
profile directory itself must be absent immediately after completed reset;
removal is not based on a partial origin list.

The interruption checkpoint is compiled only into contributor qualification
builds, requires the exact owned fixture-root name, and expires after a bounded
interval. Ordinary builds reject the fixture request. Its cancelled process is
an expected unclean negative control, not normal shutdown evidence. Other native
launches require complete ordered teardown and ordinary cleanup checks. The fixed
macOS suite requires positive verified helper/clone coverage; missed short-lived
samples remain unqualified and no real cleanup failure is suppressed.

Unit tests cover explicit intent, live lock collision, unknown/corrupt metadata,
linked files, inventory bounds and every maintained recovery phase. Launcher
regressions cover old runtimes, malformed/duplicate receipts, output bounds,
timeouts and cancellation. Those synthetic peers are not native browser evidence.

## Integrated local checkpoint

Clean source `5a732dde6bf99f365f56ae14ef073336583f442b` passed the nine-case actual
CEF 156 reset qualifier on macOS arm64. Normal launches verified all four browser
stores, preserved the second profile and completed ordered shutdown. The exact
native root-lock error is required in addition to the runtime API rejecting the
live reset. The deliberately cancelled maintenance process remains an unclean
negative control; its durable intent was subsequently observed to block opening
before successful explicit recovery.

The same checkpoint passed the 11-case RPC/session matrix, both functional CEF
transport candidates, native network/redirect/certificate and permission-policy
fixtures. An ordinary host passed its 11-case smoke matrix and separately performed
an explicit offline reset while refusing the contributor interruption requirement.
Portable validation passed 708 Bun and 205 Python tests; native checks passed
3 M1 tests, 107 ordinary CEF tests and 112 contributor CEF tests. Counts for the
focused eight Rust reset tests and four Bun launcher tests overlap those totals.

The [sanitized record](../evidence/m4-session-reset-local.json) retains report
fingerprints, the initial dirty-tree implementation diagnostic, fixture-name
collision, strict module-marker correction and failed private runner generation.
No prior failed run was relabeled successful. Final-head hosted execution remains
a separate requirement for all supported platforms; no release/security or
persistent-credential acceptance follows from the local reset results alone.
