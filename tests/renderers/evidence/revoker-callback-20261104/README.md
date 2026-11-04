# Released-callback checkpoint failure, November 4, 2026

This archive preserves an executed **headless source-suite failure**. It is
archival evidence only, on a separate branch based on the failed PR head.
It is not a product change, native qualification, new experiment or retry.

## Exact run and source

[PR #353 run 41884801689, attempt 1, Source quality job 126766271521](https://github.com/0xPlayerOne/bun-native/actions/runs/41884801689/job/126766271521)
ran `bun test tests --coverage` on Linux with checksum-pinned Bun
`1.4.4-canary.1+da867c60b`.

- PR head: `7f958333cb64b574c0bc55e0c4f0c44f4512ca37`.
- Tested merge: `d5a87f64a9a6e635a33f9f30261acd136f0d45d7`.
- Tested tree: `6aa9b146b8fd8de7336527748f6a587759f4b888`.
- Actual main parent: `3f3d84904a106e9147ccbd5e7bfa4e52065d83ed`.
- Hosted Bun executable SHA-256: `fe406996b9915f388e3fad9e6e29ece9c7cb81e06257bbcb4c50f91691b46810`.

The suite reported **589 passed, 1 failed, 3,312 assertions**, across 590 tests
in 43 files. Formatting, lint and strict types had passed. The source job
emitted no artifact upload, so the connector-returned log and first captured
step list are retained here.

## Observed failure and limits

The existing test `retained window unsubscribe handles release their callbacks
immediately`, at `tests/renderers/revoker-ownership.test.ts:22`, released all ten
registrations while deliberately retaining their release functions. After the
unchanged sequence `await Bun.sleep(0)`, `Bun.gc(true)`,
`await Bun.sleep(0)`, `Bun.gc(true)`, its strict zero-target assertion observed
**one live callback WeakRef target**.

The log does not identify that target's index or retaining root. The adjacent
window-completion callback-release case and deterministic subscription/revocation
controls passed. This observation does not establish whether an application
edge, runtime state or conservative marking kept the callback observable.
It does not identify the retaining path for earlier native AOT handles,
disposed Solid roots or React calibration probes.

The tested merge differs from its actual main parent only in four
documentation/evidence files. The compact record preserves 15 exact matching
source/configuration hashes, including the failing test, callback lifetime
implementation, fixture support, core/runtime/adapter files, package/lock
files, test configuration and source workflow. This comparison does not
establish an engine cause or clipboard defect.

[#287](https://github.com/0xPlayerOne/bun-native/issues/287) retains the
unresolved checkpoint investigation. The earlier first-open failure under
[#296](https://github.com/0xPlayerOne/bun-native/issues/296) and AOT-close failure
under [#358](https://github.com/0xPlayerOne/bun-native/issues/358) remain distinct.
The failed PR head is unchanged by this archival branch. No assertion,
collection checkpoint, timeout, isolation option or production source changed;
no failing command was rerun.

## Retained bytes

| File                              |   Bytes | SHA-256                                                            |
| --------------------------------- | ------: | ------------------------------------------------------------------ |
| `source-quality.log.gz`           |  23,207 | `f503a9ab7445a0ddcd4f41108a728cb15dbd2a8fb7a4d1d5f3452f6e693fd23f` |
| Decompressed `source-quality.log` | 108,346 | `8bfaea70785d4a14660995a93b60ad5771f48216bcebbb349d21c330b9df4771` |
| `job-steps.json.txt`              |   2,276 | `48b2bb3d0d983c914e16195dac7df7ce595f0b452f70147b8b8740a8c82ef2ff` |

The gzip uses level 9, no filename, modification time zero and OS byte 255.
Decompression was compared byte for byte with the connector-returned string
encoded as UTF-8. Compression preserves the original timestamp-only lines and
their trailing whitespace without changing hooks or attributes. The step list
keeps the exact bytes of the first connector-object capture; it is not a claim
about raw HTTP response encoding. The JSON text suffix keeps that captured
serialization separate from formatted summaries.

The log was already public Actions output. Credential-pattern checks and review
of its token/authorization contexts found only masked credentials and ordinary
permissions or test descriptions. No redaction or normalization was applied.

From the repository root, verify the archive without running the test:

```sh
python3 - <<'PY'
import gzip
import hashlib
import json
from pathlib import Path

root = Path('tests/renderers/evidence/revoker-callback-20261104')
record = json.loads((root / 'failure-record.json').read_text())
archive = (root / record['log']['archive']['file']).read_bytes()
raw = gzip.decompress(archive)
steps = (root / record['steps']['file']).read_bytes()
for value, expected in [
    (archive, record['log']['archive']),
    (raw, record['log']['uncompressed']),
    (steps, record['steps']),
]:
    assert len(value) == expected['bytes']
    assert hashlib.sha256(value).hexdigest() == expected['sha256']
print('Archived log and captured steps verified; no workload executed.')
PY
```
