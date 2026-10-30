# Windows CEF cache path normalization

The ephemeral runtime cache must use a normal absolute drive path when passed
to CEF. Rust's canonical filesystem path remains the native ownership and cleanup
identity. The CEF-facing spelling now reuses the persistent-session normalizer,
including its rejection of UNC/device namespaces and ambiguous Windows names.
No profile is moved, shared, warmed up or converted to a persistent session.

## Source-backed defect

The native host canonicalized the cache directory before assigning
`CefSettings.root_cache_path`. On Windows,
[`std::fs::canonicalize`](https://doc.rust-lang.org/1.91.0/std/fs/fn.canonicalize.html)
returns a verbatim drive path such as `\\?\C:\Cache`. Rust documents that only
backslash-delimited paths can be joined to that form. The pinned CEF
[`NormalizePath`](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/context.cc#L95-L137)
leaves this Windows spelling intact.

Chromium 156.0.8078.17 pins LevelDB revision
[`7ee830d02b623e8ffe0b95d59a74db1e58da04c5`](https://github.com/chromium/chromium/blob/156.0.8078.17/DEPS#L2551-L2552).
Its [`LockFileName`](https://chromium.googlesource.com/external/leveldb/+/7ee830d02b623e8ffe0b95d59a74db1e58da04c5/db/filename.cc#55)
appends the literal `/LOCK`. The resulting mixed-separator verbatim path passes
through Chromium's
[`LockFile`](https://github.com/chromium/chromium/blob/156.0.8078.17/third_party/leveldatabase/env_chromium.cc#L893-L910),
[`FilesystemProxy`](https://github.com/chromium/chromium/blob/156.0.8078.17/components/services/storage/public/cpp/filesystem/filesystem_proxy.cc#L263-L278),
[`LockFileLocal`](https://github.com/chromium/chromium/blob/156.0.8078.17/components/services/storage/public/cpp/filesystem/filesystem_impl.cc#L252-L278)
and [`CreateFile`](https://github.com/chromium/chromium/blob/156.0.8078.17/base/files/file_win.cc#L470-L471)
without separator normalization. An unsuccessful LevelDB lock-file open enters
the existing one-second retry loop. Persistent Bunly profiles already removed
the verbatim drive prefix; the ephemeral root bypassed that conversion.

The correction adapts the canonical local drive path only at the CEF settings
boundary. The Windows regression calls `CreateFileW` directly with LevelDB's
slash-appended filename: it requires the verbatim control to fail, the normalized
form to succeed, and both directory spellings to resolve to the same canonical
directory. A separate regression preserves namespace and alias rejection.
The existing persistent path-length policy is unchanged.

## Diagnostic evidence

Diagnostic-only [PR #211](https://github.com/0xPlayerOne/bunly/pull/211) produced
[Windows/full run 41101870731](https://github.com/0xPlayerOne/bunly/actions/runs/41101870731)
at clean source `a245b6149e1b578e13727c0413f887df6373fa07`. Its
[selected evidence](../evidence/m7-windows-readiness-trace-2026-10-30.json)
retains public artifact hashes, fixed labels and relative numeric timings.
The disposable startup trace was deleted after sanitization. The probe remains
separate from this runtime correction and is excluded from maintained acceptance.

All timings below are relative to native record creation before `StartDownload`:

| Observation                    | Measured interval                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `HistoryBackend::Init`         | Started at −549.771 ms, lasted 133.434 ms and ended at −416.337 ms; enclosing task queue wait was 0.570 ms.                      |
| LevelDB-proto tasks            | 38 observed tasks; the longest retained executions lasted 1,011.726–1,039.918 ms. The final observed task ended at 5,491.418 ms. |
| In-progress download task      | The late task ran from 5,491.413 to 5,493.614 ms, with an observed queue wait of 0.018 ms.                                       |
| Download-manager task          | Ran from 5,493.658 to 5,493.755 ms.                                                                                              |
| First native download callback | 5,493.867 ms.                                                                                                                    |
| Maintained deadline            | The first transfer failed its unchanged 6,000 ms completion requirement; timeout was observed at 6,012 ms.                       |

History initialization had completed before admission in this occurrence. The
late in-progress task and repeated roughly one-second LevelDB work are consistent
with the source-backed path defect and narrow the readiness delay to the cache
chain. The trace does not retain OS error codes or database identities, so it
does not independently prove which failed lock belongs to the download cache.
No retry count is inferred by multiplying durations. Six begin scopes and 646
flows were unmatched; event loss was not independently verified. Only eight
longest spans per label are retained, and concurrent/nested durations cannot be
summed into request latency.

## Required acceptance

Actual Windows execution must pass the kernel regression and the uninstrumented
maintained `file-downloads` fixture with the original 6,000 ms first-request
deadline, strict receipt parser, all fourteen outcomes and clean ownership.
Run the full native suite on the reviewed correction, then repeat it on merged
`main` before closing #36. Safe Browsing, quarantine/security metadata handling,
temporary ownership and the native-completion requirement stay enabled. A
successful diagnostic or cross-platform type-check cannot satisfy this gate.
