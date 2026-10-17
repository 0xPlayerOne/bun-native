# Artifact acquisition hardening

Bounded verification and fail-closed cache reuse for the shared artifact resolver.

**Status:** Shared resolver increment for M3 issue #16; not full CEF acquisition qualification.
**Scope:** `packages/artifacts`, the trusted-local-config CLI, and acquisition regression tests.

## Current archive boundary

This increment deliberately retains the existing signed `host-probe` / `backend:none`
identity and restricted, uncompressed USTAR profile (64 MiB maximum). It does **not**
accept a CEF distribution under a probe identity, raise the size cap, install an
engine at application launch, or replace the native contributor build's CEF downloader.
Full CEF distributions require a separately qualified large-archive/bundle profile,
exact CEF/helper/native version wiring, and framework-resource/link handling.

## Verification and bounded I/O

Both the signed manifest and the caller's expected identity must contain the full
supported identity schema. An untyped caller cannot bypass the ABI, target, Bun,
version, or backend checks by supplying an empty or partial object. Trusted Ed25519
keys remain caller-supplied and separate from downloaded metadata.

Every cache hit is verified, including offline hits. Directory traversal is streamed
and restricted to files and parent directories implied by the signed inventory.
Unexpected empty directories, symlinks, special files, and hard-linked regular files
are rejected. File hashes use a reusable 64 KiB buffer; reads are bounded by the
signed size plus one byte, so a growing file cannot trigger an unbounded read.
On platforms supporting `O_NOFOLLOW`, the last path component cannot be followed as
a symbolic link when opened. The private-cache threat model still excludes an
actively hostile same-user process; these checks are not a general filesystem sandbox.

Downloads must use manual, bounded redirects and independently allowed HTTPS origins.
An injected fetcher reporting automatically followed redirects is rejected. Invalid
redirect URLs and non-decimal Content-Length fields fail explicitly. The archive is
stored in one signed-size allocation instead of an unbounded list of body chunks.
This is bounded probe handling, not a streaming solution for a large CEF payload.

## Deadlines, disk space, and cleanup

`timeoutMs` defaults to 30,000 and accepts integer values from 1 to 600,000. The same
signal covers lock waiting, download, extraction, and cooperative cache verification.
Fetch/header and body waits are raced against cancellation. Late fetch responses are
cancelled; a stalled stream's cancellation promise cannot prevent the resolver from
rejecting and releasing its own lock. File operations check cancellation between
bounded reads; this does not preempt an unresponsive operating-system I/O call.

Before downloading a missing artifact, the resolver checks filesystem space available
to the user (`statfs.bavail * statfs.bsize`). Required space includes block-rounded
files, their parent directories, the staging directory, and `reserveBytes` (default
1 MiB; a nonnegative safe integer). A verified cache hit does not require extraction
space. This is a preflight, not a disk reservation: later ENOSPC/EDQUOT failures still
fail the acquisition, and staging is not published as verified.

Only a completely verified stage is renamed into the cache. Handled errors and
cancellation attempt stage cleanup, lock-handle closure, and lock removal independently.
Cleanup failures are surfaced, together with any acquisition failure. Cancelling a
lock waiter never removes the current owner's lock.

Abrupt process death or power loss may still leave a lock/stage. Automatic stale-lock
reclamation and concurrent-safe cleanup commands remain open under #16; a timeout is
not proof that another owner is dead, and live locks are never stolen based on age.
Atomic rename here is a publication boundary, not a claim of full power-loss durability.

## Read-only inspection

Use the same independently trusted local JSON configuration as resolution:

```sh
bun packages/cli/src/main.ts artifact inspect <trusted-local-config.json>
bun packages/cli/src/main.ts artifact resolve <trusted-local-config.json>
```

Inspection verifies the exact requested entry and reports `verified` or `missing`.
It performs no downloads, extraction, cache-root creation, lock acquisition, or deletion.
Corrupt/unsafe entries produce an error and nonzero CLI exit, not a successful
`verified` status. A missing entry can also mean another consumer has not published
its stage yet; inspection is not a lock-health or stale-lock classification tool.

## Validation and remaining evidence

`tests/artifact-acquisition.test.ts` covers complete expected identities, malformed
URLs, unexpected cache directories, hard links, cancellation during offline reuse,
space preflight, invalid budgets/deadlines, stalled fetches and streams, late responses,
redirect policy, Content-Length syntax, independent concurrent consumers, lock ownership,
and read-only inspection. Existing signature/checksum/archive and offline tests remain.
Run `bun test tests/artifacts.test.ts tests/artifact-acquisition.test.ts` and `bun run check`.

The disk-space regression forces an impossible reserve before download; it is not a
real quota/full-disk write test. Full CEF extraction, signed distribution integration,
process-crash recovery, quota/interruption fault injection, cache-clean commands, and
release key distribution remain unqualified by this increment. Do not close #16 based
on these portable tests alone.

API references: Node.js file-system documentation (`fs.StatFs` and `FileHandle.read`)
and Bun's `node:fs/promises.statfs` reference. The implementation uses only the existing
pinned Bun runtime and built-in modules; no new dependencies or trust roots are added.
