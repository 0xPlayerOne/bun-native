# M7 native view composition observations

The manifest binds two failed native attempts and the accepted macOS run to
their exact source commits and compressed, sanitized reports. Original report,
exported JSON, and compressed archive digests are recorded separately. Exports
remove fixture correlation nonces and replace workspace/home prefixes with
markers; outcomes, observations, timing, runtime inventories, and cleanup results
remain unchanged.

| Archive | Source | Outcome |
| --- | --- | --- |
| `composition-renderer-focus-failure.json.gz` | `e6c8fb01168b2712ad37f9785da230397a618dd9` | Failed at the unchanged 25-second fixture deadline after ten observations. API focus changed the Views selection without reliably activating the overlay's native window; the right renderer retained focus. |
| `composition-native-focus-failure.json.gz` | `cd3d77fb1d70fca1a99ae92426c8148fc4ad3c1d` | Explicit overlay activation produced the real renderer blur, but the macOS Views focus manager still selected the now-ineligible pane. The recorded pending observation shows native focused=true and renderer focused=false. The same deadline failed. |
| `composition-macos.json.gz` | `2771bed9af84c956372ca8bbac56711508640ecc` | Passed all 28 observations, eight focus transfers, 16 resize transitions, two generation reattachments, three retained documents, stale/hidden/clipped/nonfocusable rejection, overlay closure with sibling survival, and native/process/helper cleanup. |

The accepted implementation activates an overlay only for an explicit focus
request; ordinary resize does not re-show and steal focus. On macOS, a focused
pane that becomes ineligible hands the shared native focus selection to the
owning window. This is limited to a drawn, unminimized window and verifies actual
CEF focus release. It makes no Windows/Linux activation assumption and selects
no arbitrary sibling. The source analysis and physical traversal limitation are
described in [view composition](../../docs/view-composition.md).

Each run used a freshly built native tree matching its declared source. The
runner verified actual CEF 156.0.7 / Chromium 156.0.8078.17 exports, bundled Bun
1.4.3, complete runtime file inventories and prepared file metadata. These remain
declared build sources and inventoried artifacts, not embedded build
attestations. Both failed runs exited 1 and remain failed; none was relabeled as
a pass. No timeout, cleanup condition, or focus assertion was weakened.

The accepted macOS ARM64 execution took about 3.51 seconds under the process
observer. That is a functional observation, not a performance result. The run
observed a browser device-pixel ratio of 2; it does not establish physical input,
IME, screen-reader behavior, hardware DPI, multiple-monitor support, or a
performance comparison. Those parts of #35/#38 remain open. The final-head
three-platform merge checks are recorded in
[PR #133](https://github.com/0xPlayerOne/bunly/pull/133).

## Replay the accepted export

From the repository root, with its historical Git objects already present:

```sh
python - <<'PY'
from pathlib import Path
import gzip, hashlib, json
root = Path('evidence/m7-view-composition')
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
        Path('.bunly/composition-retained-acceptance.json').write_bytes(exported)
PY
bun run qualify:desktop --verify .bunly/composition-retained-acceptance.json
```

Replay checks the exact historical source inventory and native source tree,
complete native and renderer observations, runtime identity, artifact/metadata
integrity, ordinary teardown, output drain, and positive macOS helper cleanup.
It launches no desktop, fetches no source, and reconstructs no private observation
identity. Failed exports cannot satisfy the success validator.
