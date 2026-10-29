# M7 desktop window observations

The manifest binds three original private reports to compressed, nonce-redacted
exports and exact historical source commits. Workspace and home prefixes are
replaced with markers. Original report, exported JSON and compressed archive
digests remain separate. No fixture outcome, event, timeout, artifact inventory or
cleanup condition was changed during export.

| Archive | Source | Outcome |
| --- | --- | --- |
| `window-error-brand-failure.json.gz` | `84e8589992e2bf0d701ea45d5b9b4599522cce73` | All thirteen native states completed, then the fixture rejected the correct `INVALID_ARGUMENT` because the app and bootstrap bundled different error constructors. The backend exited 1. |
| `window-restore-readiness-failure.json.gz` | `a0edc67d6ece669f61f6371ea2c699279070da5c` | The fixture reached minimize, then its notification-only restore wait hit the unchanged 25-second deadline. The backend exited 1. |
| `window-controls-macos.json.gz` | `e5316ebd48d771ffd490a24b814aabcfd0b80ed2` | Passed thirteen native observations, five authenticated renderer visibility receipts, both completed fullscreen transitions, one close event, zero callbacks after abort, invalid/stale handle rejection and final resource/process/helper cleanup. |

The accepted correction correlates native state with actual page visibility for
hide/show/minimize/restore. It adds no sleep, repeated mutation, longer deadline or
synthetic visibility. The prebuilt native source was `84e8589` in all three runs;
only the TypeScript fixture and its validator changed. The runner verified the
matching native source tree, actual CEF 156.0.7 / Chromium 156.0.8078.17 exports,
Bun (version redacted), runtime files and file metadata. This remains a declared build source
with artifact inventories, not embedded build attestation.

The native run was macOS arm64. Its observed device-pixel ratio of 2 is a browser
value, not hardware-DPI qualification. Physical input, IME, assistive technology,
multiple monitors and performance eligibility remain unqualified. The current
three-platform merge gates are recorded in
[PR #132](https://github.com/0xPlayerOne/bunly/pull/132).

## Replay the accepted export

From the repository root, with the historical Git objects already present:

```sh
python - <<'PY'
from pathlib import Path
import gzip, hashlib, json
root = Path('evidence/m7-desktop')
manifest = json.loads((root / 'manifest.json').read_text())
for row in manifest['runs']:
    archive = (root / row['archive']).read_bytes()
    assert len(archive) == row['archiveBytes']
    assert hashlib.sha256(archive).hexdigest() == row['archiveSha256']
    exported = gzip.decompress(archive)
    assert len(exported) == row['expandedBytes']
    assert hashlib.sha256(exported).hexdigest() == row['expandedSha256']
    if row['passed']:
        Path('.bunly').mkdir(exist_ok=True)
        Path('.bunly/desktop-retained-acceptance.json').write_bytes(exported)
PY
bun run qualify:desktop --verify .bunly/desktop-retained-acceptance.json
```

Replay verifies historical source fingerprints, complete native receipts, actual
runtime identity, artifact and metadata integrity, ordered shutdown and positive
macOS helper cleanup. It performs no native launch, implicit source fetch or
reconstruction of private observation identities. Failed reports remain failed
and cannot satisfy the success validator.
