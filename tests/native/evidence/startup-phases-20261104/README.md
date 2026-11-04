# Archived first-window phase observations

All three predeclared observations in
[research PR #359](https://github.com/0xPlayerOne/bun-native/pull/359) passed.
No original first-open timeout was reproduced, so no unfinished internal phase
or production cause was established. [Issue #296](https://github.com/0xPlayerOne/bun-native/issues/296)
and the original failed required check for #353 remain unresolved. This archive
preserves completed research; the research branch is not a main-merge candidate.

## Source and measured scope

The observations ran from source **f143b8d4c4b32813a970c7f581df4a55ccdd8fa1**,
tree **da6792b4a19bc577bbcb1b966a4d0daf6cb79d9e**, in
[run 41872112972](https://github.com/0xPlayerOne/bun-native/actions/runs/41872112972).
That tree is identical to reviewed local commit
e370332febde604f109c2f2a2558cfae372c25d7. The later commit containing this archive
is **not the observation source**.

Workflow attempt 1 ran exactly three jobs on distinct GitHub-hosted Ubuntu 24.04
runner IDs. Each ran one original five-window lifecycle process, with zero
warmups or retries. The application was the Bun development TypeScript fixture;
the native host was an instrumented Rust release build. This was not AOT
application qualification.

The original GPUI pin ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d, Vulkan|GL
backend selection, 5,000 ms request deadline and 45-second lifecycle ceiling
were preserved. All 13 recorded repository source hashes matched the published
Git tree. All three original/instrumented dependency file hashes were
reconstructed from pinned Git bytes. Every archived dependency patch matched
the reviewed transformation byte-for-byte.

| Trial | Job          | Artifact ID | ZIP bytes | Lifecycle duration | First request to opened | Completed phase pairs |
| ----- | ------------ | ----------- | --------: | -----------------: | ----------------------: | --------------------: |
| 1     | 126721709151 | 13345816090 |    18,286 |            3.488 s |            2,736.903 ms |                 11/11 |
| 2     | 126721709236 | 13346315399 |    18,375 |            3.046 s |            2,456.312 ms |                 11/11 |
| 3     | 126721708835 | 13344469690 |    18,413 |            4.083 s |            3,596.097 ms |                 11/11 |

Each raw trace had one correlation nonce, one application PID, one native host
PID, one hello and one shutdown. Independent validation matched the full
indexed request/response sequence, including the unchanged fixture's intentional
invalid-handle and stale-revision controls. All five native window cycles
completed. Native and application exit codes were zero; output capture joined;
there was no forced termination, remaining observed process, unreaped process,
discarded output or outer-deadline violation.

Each first open contained 22 boundaries forming 11 correctly nested phase
pairs, with no error boundary, truncation or unfinished phase. Independently
computed spans matched both the raw result and the published parser.

## Timing interpretation

| Native logger phase             |      Trial 1 |      Trial 2 |      Trial 3 |
| ------------------------------- | -----------: | -----------: | -----------: |
| X11 colormap                    |     0.041 ms |     0.066 ms |     0.055 ms |
| X11 setup                       |     0.203 ms |     0.289 ms |     0.149 ms |
| Instance                        | 1,941.898 ms | 1,676.378 ms | 2,916.907 ms |
| Device request                  |   747.021 ms |   735.158 ms |   632.090 ms |
| Renderer, including nested work | 2,735.780 ms | 2,455.078 ms | 3,594.754 ms |

Phase durations use only the native logger clock. The separate request-to-opened
values use only the application transport clock. A parent span must not be added
to its nested spans. Logging, scheduling, build paths, cache state and hosted
hardware affect timing. Trials 1 and 2 used AMD EPYC/Azure runners; trial 3 used
an Intel Xeon/AWS runner. These observations are not a controlled performance
comparison and do not establish a cause for the historical timeout.

## Contents and integrity

[summary.json](summary.json) records source identity, all original artifact ZIP
IDs/digests, job and runner IDs, phase durations, cleanup results and the
byte count/SHA-256 of each retained record. Each original ZIP size and digest
matched GitHub metadata before extraction.

Each trial directory preserves the exact original plan, host identity receipt,
exclusive attempt receipt, result, startup trace, lifecycle output and toolchain
record. `.json.txt` and `.jsonl.txt` preserve the raw JSON bytes without applying
JSON formatting. Hosted runner paths and process identifiers in those records
are historical provenance, not portable setup instructions.

`dependency.patch.gz` contains one lossless copy of the identical dependency
patch from all three trials. Gzip uses a zero timestamp and no original filename.
Compression preserves the unified diff's required single-space context lines
while keeping the normal whitespace hook unchanged. The compressed and original
SHA-256 values are recorded separately. Original patch SHA-256:

`3a2c2abef7d184257b3e1b2736206371526bbd05baf0ddd4585f7c7570ebd45e`

The native binaries, reproducible build logs, window-manager setup logs and ZIP
containers are omitted. Release-host hash/size receipts remain. The reviewed
runner computed those hashes before execution and verified them again afterward;
the binaries cannot be independently rehashed from this archive. The three
independently built host hashes differ; no binary reproducibility claim is made.

From the repository root, verify every retained raw record and the lossless patch
without executing any application or writing to a dependency checkout:

```sh
python3 - <<'PY'
import gzip
import hashlib
import json
from pathlib import Path

root = Path('tests/native/evidence/startup-phases-20261104')
summary = json.loads((root / 'summary.json').read_text())
records = [row for trial in summary['trials'] for row in trial['records']]
for row in records:
    data = (root / row['path']).read_bytes()
    assert len(data) == row['bytes'], row['path']
    assert hashlib.sha256(data).hexdigest() == row['sha256'], row['path']
patch = summary['archive']['dependencyPatch']
encoded = (root / patch['path']).read_bytes()
assert len(encoded) == patch['bytes']
assert hashlib.sha256(encoded).hexdigest() == patch['sha256']
decoded = gzip.decompress(encoded)
assert len(decoded) == patch['originalBytes']
assert hashlib.sha256(decoded).hexdigest() == patch['originalSha256']
print(f'Verified {len(records)} raw records and the original dependency patch')
PY
```

For inspection, `gzip -dc tests/native/evidence/startup-phases-20261104/dependency.patch.gz`
prints the exact original patch. Do not apply it to a shared dependency checkout.

## Archival disposition

This archive adds no observation, changes no research source and qualifies no
required check. Its files are confined to `tests/native/evidence/startup-phases-20261104/`,
outside all three push path filters in the research workflow. Publishing only
this archive does not request another research trial. Preserve the completed
three-trial result and archive PR #359 unmerged; do not infer that #296 is fixed
or that the failed #353 required check has passed.
