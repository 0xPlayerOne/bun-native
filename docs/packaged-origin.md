# Packaged application origin

Manifest-contained resources, explicit browser policy, and bounded responses.

**Status:** M3 issue #17 implementation; real-browser acceptance remains open.
**Origin:** `app://ui`.

## Resource boundary

The native host resolves `Resources/public` on macOS and `resources/public` on
Windows/Linux from its installed executable. The working directory, backend
bundle, and a development HTTP server are not fallback roots. Files are read in
place without per-launch extraction.

`assets.json` is an allowlist, not an instruction to serve a directory. Unknown
files return 404 even when present. Duplicate/case-colliding inventory entries,
hidden segments, known source/private configuration names, unsafe platform names,
observed symlinks and escaped canonical paths are rejected. Percent decoding is
performed once; malformed escapes and encoded separators fail. Unicode asset
names remain supported.

Each asset is bounded to 32 MiB and checked for size and SHA-256 before serving.
The inventory is bounded to 1 MiB and 10,000 entries. These are per-request limits,
not a total-RSS guarantee. A full GET moves its verified buffer into the response
rather than copying a second vector.

The inventory is not an authenticity root; signed acquisition belongs to #16.
Secrets intentionally embedded into approved frontend code remain extractable.
The installed root must be private to the user; observed-link checks are not a
defense against an actively racing process with the same user's write authority.

## Response behavior

GET and HEAD are supported; other methods return 405 with Allow. Modules, WASM,
images, fonts and media have explicit MIME types and nosniff. Single byte ranges
support start/end and suffix forms; unsatisfiable ranges return 416. HEAD ignores
Range and retains full representation length without a body. Unknown range units
and multipart requests receive the complete representation.

ETag is the verified digest. GET/HEAD If-None-Match supports matching tags, weak
comparison and the wildcard. If-Range requires an exact strong tag; unsupported
or mismatched validators receive the full representation. File integrity is
rechecked before 304, so a matching browser validator cannot hide modified
installed bytes. Errors are bodyless and no-store. URI/header lengths are bounded
before asset reads. This restricted behavior follows RFC 9110 sections 13 and 14:
https://www.rfc-editor.org/rfc/rfc9110.html

## Browser authority

The CEF scheme retains STANDARD, SECURE, CORS_ENABLED and FETCH_ENABLED; it does
not enable LOCAL or CSP_BYPASSING. Successful and error responses receive CSP,
nosniff, same-origin Cross-Origin-Resource-Policy, no-referrer and restrictive
Permissions-Policy. These headers do not grant native capabilities or replace
native frame/document attestation in #19.

No bridge, loopback server, debugging endpoint, remote-navigation grant or sandbox
change is introduced. The current host still permits local app content and
about:blank, denying unqualified remote navigation. Development-server origins
must be separately authorized rather than inferred from localhost.

## Verification

31 native library tests pass on Linux x64 with Rust 1.91.0: 15 retained tests plus
16 new resource regressions. Host/helper/packager APIs also pass the documentation-
only CEF check. This mode avoids downloading/linking CEF and is never a shipping
profile. Actual packaged-browser, sandbox, macOS and Windows checks were not run
in this continuation. #17 remains open until its real module/frame/redirect,
offline, missing-asset and navigation-isolation fixtures have completed.
