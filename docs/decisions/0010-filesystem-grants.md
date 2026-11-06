# ADR 0010 — Scoped filesystem grants

Status: accepted; Linux implementation verified locally in development and
inspected AOT with a development-profile host on an isolated Xvfb display.
Hosted release-host qualification runs in Native Linux. The macOS backend is
type-checked and linted locally for `aarch64-apple-darwin` and its walk logic
runs in the Linux unit tests; its only macOS execution evidence is the hosted
`macos-15` Native Platforms job. Windows reports the service unavailable.

Date: 2026-11-05.

Related: [#304](https://github.com/0xPlayerOne/bun-native/issues/304),
[shared services #255](https://github.com/0xPlayerOne/bun-native/issues/255),
[Adea port #250](https://github.com/0xPlayerOne/bun-native/issues/250),
[trust boundary](0003-bridge-security.md) and
[service policy](0005-native-service-policy.md).

## Context

The Adea workspace needs file authority that can be handed to less trusted
parts of an application, such as model tools or rendered content, without
handing them a path string. A path is not a permission: text from a model, a
dropped file name or a rendered link must never become access by itself.
Ordinary Bun filesystem APIs remain the trusted application's own authority and
are outside this broker; this service does not sandbox them.

The risks are traversal (`..`, absolute names), symbolic links that point out
of the granted tree, special files whose open has side effects (FIFOs,
devices), rename races between a check and a use, and grants or results that
outlive their owner.

## Decision

Protocol 9 adds an immutable `filesystemRoots` launch permission: up to eight
`{ id, path, access }` entries, each an absolute normalized directory with
`read` or `read_write` access. The runtime passes each as a reserved
`--bun-native-filesystem-root=<access>:<id>:<path>` argument and readiness must
report the identical ordered list. No wire command names a path outside a
grant, and no command can add a root.

`NativeWindow.openFileGrant(root, { access })` opens a grant on a root ID at no
more than its launch access. The host opens the directory once, on a worker
thread, as an `O_PATH` descriptor; the descriptor, not the path, is the grant.
Renaming the root afterwards keeps the grant on the same directory. A grant is
owned by its window: closing the grant, the window or the application revokes
it, and the core withholds any result that arrives after revocation.

Requests carry a grant ID and a relative path of `/`-joined names (at most
1,024 bytes and 32 components; no empty, `.`, `..` or control-character
names). Both language implementations reject other paths before any I/O. The
host then resolves every path with
`openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)`
relative to the grant descriptor, so the kernel enforces confinement even if
the tree changes between requests. Symbolic links are never followed, inside or
outside the grant; `stat` and `list` report them as `symlink`, and `remove`
removes the link entry itself. Without `openat2` (Linux before 5.6) the host
does not advertise `filesystem_grants_v1`.

macOS has no `openat2`. Its host walks the validated path one name at a time:
each step is `openat(dirfd, name, O_NOFOLLOW | O_NOFOLLOW_ANY | O_CLOEXEC |
O_NOCTTY)` relative to the descriptor the previous step returned, starting at
the grant's `O_RDONLY | O_DIRECTORY` descriptor, and every intermediate step
adds `O_DIRECTORY`. Validation already forbids `/`, `.`, `..` and empty names,
so a step can only name a direct child of a directory reached from the grant;
`O_NOFOLLOW` refuses a link as that child, and `O_NOFOLLOW_ANY` (macOS 11 and
later) makes the kernel refuse a link anywhere in the step's resolution as
defence in depth. A link opened as a directory that reports `ENOTDIR` is
re-checked with `fstatat(AT_SYMLINK_NOFOLLOW)` and reported as `path_denied`
like every other link. As with `RESOLVE_BENEATH`, which guards only `..` and
absolute names, a directory renamed out of the tree while a walk holds its
descriptor remains the directory that was opened; no path text is resolved
again. Differences from Linux: intermediate directories must be readable (no
`O_PATH`), and names resolve as the volume does, so a case-insensitive APFS
volume matches `A.TXT` to `a.txt` within the grant. Both backends share the
operation code, so wire semantics and error codes are identical. The capability
record names the backend: `openat2` on Linux, `openat_walk` on macOS.

Operations are `stat`, `list` (pages of 64 entries sorted by UTF-8 bytes, with
an `after` cursor and a count of unrepresentable names), `read` and `write` of
at most 16,384 bytes per request (base64 on the wire), `create_directory` and
`remove`. Writes need a `read_write` grant and accept `create` (exclusive),
`truncate` and `append`. Reads and writes open with `O_NONBLOCK | O_NOCTTY` and
refuse anything but a regular file before transferring a byte, so a FIFO or
device is never read, written or truncated.

Errors are typed: `permission_denied` (policy), `not_found`, `already_exists`,
`path_denied` (a link or an escape), `wrong_kind`, `not_empty`,
`access_denied` (the OS refused), `limit_exceeded` and `cancelled`.

## Alternatives

- **Absolute paths checked against an allowlist.** A string prefix check is
  defeated by links and by renames between check and use. Descriptor-relative
  `openat2` makes the kernel the check.
- **Following links that stay inside the grant.** Resolving a link safely needs
  the same kernel support and makes the visible tree differ from what the
  grant holds; refusing all links is simpler to reason about and to test.
- **A file picker as the only source of grants.** OS file selection is a user
  choice, but it is a separate service (dialogs, #239) with its own modality
  and cancellation. This ADR keeps selection separate from authorization:
  converting a picked or dropped file into a grant remains follow-up work and
  must go through an explicit user choice, never a dropped path string.
- **Doing I/O on the UI thread.** A slow mount would stall input and paint. The
  worker keeps the UI thread and the tree queue free, bounded by the shared
  eight-request service limit.

## Consequences and verification

Applications that need file authority declare their roots at launch and pin
the packages and host together. The grant gives no protection from the trusted
application itself, its dependencies or a different process.

Rust unit tests exercise confinement, link refusal, write modes, directory
pages, special files and renamed roots on real files. A shared fixture of 72
command and event cases runs through both parsers. Headless core tests cover
argument mapping, client-side path rejection, revocation, policy mismatch and
mismatched result shapes. The native test
[`tests/native/filesystem-grants.ts`](../../tests/native/filesystem-grants.ts)
runs the real host in development and AOT on an isolated display, checks every
effect independently with `node:fs` on a private tree, verifies that a sibling
directory is untouched, and drives the private runtime directly to show the
host rejects foreign, stale and reused grant IDs. On Linux the unit suite runs
against both the `openat2` backend and the macOS walk (without
`O_NOFOLLOW_ANY`, which Linux lacks). The Native Platforms `macos-15` job runs
the same Rust unit tests and the same native test in development and inspected
AOT; that hosted job is the only macOS execution evidence, and no local Mac
has run it. Windows remains unavailable until it has an equivalent
kernel-enforced confinement.
