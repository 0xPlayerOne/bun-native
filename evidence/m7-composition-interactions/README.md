# M7 composition interaction observations

This directory retains actual attempts of the separate
[`native-composition-interactions-v1` workload](../../docs/desktop-qualification.md#composition-interactions)
from [PR #210](https://github.com/0xPlayerOne/bunly/pull/210). Failed attempts stay
failed. The workload, source inventories, native deadlines and full-suite
prerequisite remain unchanged.

## macOS interaction result and preceding attempts

All three Mac attempts are retained, including a preparation failure before any
native launch and an unsuccessful first fixture execution.

| Attempt | Application source | Workload duration | Outcome |
| --- | --- | ---: | --- |
| Preparation | `8662a164fe3b1cb664ed75693cf59e3b6a29d047` | Not launched | Expected packaged `runtime.json` was absent |
| First native execution | `8662a164fe3b1cb664ed75693cf59e3b6a29d047` | 2,517.4415 ms | Native hidden-focus denial was misclassified by the fixture |
| Corrected native execution | `bebcaf49cdd66b3da25fe8b7bb76a6bd2685f70d` | 2,472.698166 ms | Complete interaction profile passed |

The successful record contains ten ordered focus observations, three real native
menu opening/cancellation pairs, a visible native file panel and its completed
cancellation, rejection of a competing popup while that panel remained owned,
and three preserved document/session identities. Renderer producers stopped and
their RPC replies drained before teardown. Native view/session/queued-delivery
and command-registration counts reached zero, SDK resources reached zero, and
the host reports `clean: true`. The common artifact/source identity, native
shutdown, output drain and process/helper cleanup gates passed.

The first native execution had already completed the panel interaction. It
failed at the following hidden-overlay focus assertion because that direct view
operation returns a plain native transport `Error`, while the initial fixture
expected a structured SDK error. Its original receipt retains the earlier stage
label `overlay-dialog-closed`; that label is not rewritten in the archive.
The correction accepts only the exact expected native denial, with explicit
opt-in, and improves subsequent stage labels. Other denial reasons, error codes,
prefixes and error shapes still fail. No native code, deadline, visibility rule
or required observation changed between these two native attempts.

All Mac attempts declared native build source
`be22c89a1c680c3262316e516f22a4816cbf4e9c`, matching native tree
`9ed1b04c6d65b5351c064c4b3ea03ae0e7d4cc88`. The executed app reports Bun 1.4.4,
CEF 156.0.7 and Chromium 156.0.8078.17. Complete input/prepared host and browser
hashes remain in the manifest and reports. Native build attribution is a checked
operator declaration, not embedded binary build attestation. The connected Mac
session used a Screen Sharing Virtual Display; it supplies no physical display,
IME or assistive-technology qualification. The fixture is not performance eligible,
and its elapsed duration is not an input-latency or renderer-performance result.

## Linux initial-hidden failure

| Attempt | Application/native source | Workload duration | Outcome |
| --- | --- | ---: | --- |
| [Hosted Linux run 41101637251](https://github.com/0xPlayerOne/bunly/actions/runs/41101637251) | `bebcaf49cdd66b3da25fe8b7bb76a6bd2685f70d` | 30,037.326442 ms | Failed at the first focus checkpoint |
| Local Linux baseline | `bebcaf49cdd66b3da25fe8b7bb76a6bd2685f70d` | 30,047.958876 ms | Same mismatch reproduced |
| Local Linux candidate | `0584f3bf7ab4d287706beb345b2c5d1eb680c1fc` | 30,026.872395 ms | Same mismatch; candidate withdrawn |

At `left-ready`, the overlay's native state is hidden, undrawn, nonfocusable and
unfocused. Its authenticated renderer receipt still reports `visibility: visible`
at sequence zero, with a zero-sized viewport. The left and right content-pane
observations agree. No menu or dialog step is reached, so those interactions
are not qualified by these Linux attempts.

All three failures preserve zero SDK resources and a fulfilled application
shutdown request, with no observed orphan or surviving process. The native host
nevertheless reports `clean: false`, and the process exits with code 1. Those
cleanup observations do not convert an unsuccessful workload into a pass.
Post-run artifact inventory checks were not reached; their absence is retained.

The hosted artifact contains two byte-identical names for this report. Only one
copy is archived here. Its original downloaded report SHA-256 is
`7e3e72c2d27cdd3440fb9a86a4aad0e8a67f5a9a837e404748112bf44b554c45`.
Artifact ID `13000456175` came from the linked run; the downloaded ZIP SHA-256 is
`aa987a79549f2fd7acc49992f836edc5bcbc21bf133ce41ff8a8f4e4255d5f71`.
The separately retained [qualification record](linux-qualification.json) records
19 other successful ordinary stages and the failed composition prerequisite.
Credential qualification remains blocked by that failure.

### Withdrawn candidate

The seven-line BrowserView visibility candidate passed 265 native library tests
and focused portable checks, then failed the actual Linux workload. It is not a
runtime fix. The normal revert published as
`47b02d83c02ab3590fe293b89d16899e389a209e` restores the original native tree
`9ed1b04c6d65b5351c064c4b3ea03ae0e7d4cc88`.
The candidate's distinct native tree
`7eda6d87db73a8551da4e9709e5adec1b14525ba` and failed report remain in the
[manifest](manifest.json). The [upstream analysis](upstream-initial-visibility.md)
explains why native visibility updates do not supply the missing initial
document-visibility setting in the pinned creation path.

## Artifact integrity and privacy

The manifest records each original report's digest, sanitized-input digest where
applicable, compressed archive size/digest, expanded JSON size/digest, exact
application/native source, runtime identity, input/prepared host hashes, outcome,
pending focus snapshot and cleanup observations. The hosted input was already a
native evidence export; its digest is not represented as the private raw
observer report's digest.

Exports use the maintained `scripts/export_native_evidence.py`, followed by
explicit replacement of the composition/native-build checkout and home prefixes
on macOS, and hosted checkout/local Linux checkout/run/workspace prefixes on
Linux. Nonce/correlation export metadata is preserved. Outcome,
source, runtime identity and application receipt fields were compared with the
inputs and remain unchanged. No private raw reports, native binaries, keys or
profiles are published here.

The archives use gzip compression with a zero timestamp and contain one JSON
report each. They are not application bundles. Verify compressed and expanded
bytes against the manifest before replaying. With the recorded source objects
already present locally, expand an archive to a temporary JSON file and run:

```sh
bun run qualify:desktop --verify /absolute/path/to/expanded-report.json
```

The successful Mac archive replayed with exit code zero, including its complete
historical source inventory and native-source tree checks. Both failed Mac
reports and all three failed Linux reports were rejected because they record
`passed: false`. A nonzero exit is required for those five records; failure
rejection occurs before the positive source/acceptance gates, and does not
promote or reclassify a failed attempt. Replay performs no native execution and
does not implicitly fetch source.

## Qualification boundary

These are SDK-driven native integration observations. Physical keyboard/pointer,
IME, screen readers, hardware DPI/display topology and performance remain
unqualified. No hidden content was briefly exposed, no renderer visibility was
injected, and no observation requirement was relaxed to obtain a pass.
The strict initial-hidden case continues to block complete Linux interaction
qualification and issue #35 remains open.
