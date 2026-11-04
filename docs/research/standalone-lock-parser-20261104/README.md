# Standalone lock parser: preserved failure and bounded follow-up

This data-only record preserves two separate controller outcomes. The first
controller failed its declared diagnostic assertion and stopped. A subsequent,
source-reviewed controller executed exactly the three previously unrun inputs:
the original React lock was rejected, and the corrected Solid and React locks
were parsed and listed successfully. The original Solid command was not repeated.
Its original failure remains unchanged.

These are parser/listing results for inert manifests and locks. They do not
qualify package installation, offline-cache use, relocation, public imports,
type closure, AOT compilation or native execution. The earlier failed consumer
cohort remains separate in [research archive #394](https://github.com/0xPlayerOne/bun-native/pull/394).

## Measured sources and outcomes

The source identities below are the exact local commits that were measured. Each
raw result retains all 533 tracked-source byte hashes; each archive also contains
its exact committed controller and plan. The commit storing this record is an
archival commit, not a new measured source.

| Capture   | Measured commit                            | Measured tree                              | Controller outcome                                           |
| --------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------ |
| Initial   | `c16db30583767094cabccbb5875d42ad12af40ac` | `75762af6c881bc00e61af4860c1b62eb815105d1` | Failed; three later inputs not run                           |
| Follow-up | `39d2b878540f23863b617e42fb6c2f6a8df6ed94` | `e5402f51e1997603481f690bee63df184d7fd9f0` | Three previously unrun inputs passed their declared controls |

Both use Bun revision `da867c60bf0bcbf9d6d36994f8ca0efa42075115`, on the
controller's required Linux x64 platform. The executable is 138,468,432 bytes,
SHA-256 `fe406996b9915f388e3fad9e6e29ece9c7cb81e06257bbcb4c50f91691b46810`.
Each direct command is `bun pm ls --all` in an owned directory containing only
the declared `package.json`, `bun.lock` and empty cache. No package archive or
`node_modules` directory is provided to those commands.

| Capture   | Input           | Child exit | Recorded control status                                  | Recorded elapsed time |
| --------- | --------------- | ---------: | -------------------------------------------------------- | --------------------: |
| Initial   | Original Solid  |          1 | Failed: required inner diagnostic was absent             |           5.254296 ms |
| Follow-up | Original React  |          1 | Passed: exact public negative diagnostic                 |           3.737879 ms |
| Follow-up | Corrected Solid |          0 | Passed: selected local packages and nested helper listed |           4.703320 ms |
| Follow-up | Corrected React |          0 | Passed: selected local packages and nested helper listed |           3.555915 ms |

There are four distinct executed commands across these captures. The initial
controller's original React and corrected-lock records remain `not-run`; the
follow-up reports its executions separately. Every executed child has no signal
and `exitedDueToTimeout: false`. The initial outer owner exited 1 and the
follow-up outer owner exited 0; both joined their direct child without forced
termination. Timing values describe these observations and are not performance
baselines.

Each controller retained a 10-second limit per parser call with explicit
`SIGKILL`, a 45-second parser-call window, and failure on any timeout, signal,
installer-fallback output or changed input. The follow-up validates the exact
prior failed result and its stdout/stderr before staging and again afterward.
The original failure is a separate reference, never a passing follow-up control.

## Why the first control failed

The first child returned exactly 49 bytes on stderr and no stdout:

```text
error: failed to parse lockfile: InvalidLockfile
```

The original assertion additionally required a missing-root diagnostic. Pinned
Bun's [`pm ls` path](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/runtime/cli/package_manager_command.rs#L596-L623)
calls its own [generic error helper](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/runtime/cli/package_manager_command.rs#L133-L159),
which prints the public error name and exits. The parser
[accumulates the missing-root detail](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/install/lockfile/bun.lock.rs#L3302-L3344)
in its log, but this command's helper does not print that log. A
[different reporting path](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/install/lockfile.rs#L458-L476)
explicitly prints both. The initial source review incorrectly treated the stored
detail as emitted output. The observed command result corrects that expectation;
it does not retroactively change the failed control.

The follow-up negative therefore requires the exact 49-byte public stderr,
empty stdout and exit 1, together with the existing signal, timeout, fallback
and invariant checks. It changes no product lock implementation. Only the
controller and its plan differ between the two measured sources; the other 531
tracked file digests match. The corrected staged lock bytes are identical in
the two captures.

## Bounded conclusions from retained data

An independent data audit rehashed every follow-up source file against its
historical Git object, each referenced original input, the control logs and
staged files. It also compared all 17 initial archive members with their original
bytes. Source, compiler, input and owned-directory before/after records match;
the follow-up's prior-failure files also remain identical.

The corrected Solid lock retains 55 original registry rows and adds six selected
local tarball rows, for 61 total. The corrected React lock retains 57 registry
rows and adds six local rows, for 63 total. Every retained registry tuple and its
metadata equals the original package-set manifest. Each local row has the
expected raw relative tarball path, dependency/bin metadata and SHA-256 integrity;
the lock's overrides equal the original generated manifest. Both positive logs
list the six selected local packages and the distinct nested
`@babel/helper-module-imports@7.18.6` dependency. These comparisons use retained
JSON and output bytes, without executing the archived source.

The records establish rejection/listing behavior for the declared inputs on the
pinned executable. They establish no installation or later consumer acceptance,
no GC or retention cause, and no arbitrary descendant-process cleanup.

## Archive contents and verification

This is one combined research record with two separately identified raw captures:

| File                                 | Compressed bytes | Regular members | Uncompressed member bytes | SHA-256                                                            |
| ------------------------------------ | ---------------: | --------------: | ------------------------: | ------------------------------------------------------------------ |
| `parser-control-c16db305-raw.tar.gz` |           75,691 |              17 |                   280,773 | `ae050f9caf280978947289bb1478983a35900f7d2e0768e981cef921dcab13e6` |
| `parser-control-39d2b878-raw.tar.gz` |           77,653 |              19 |                   276,327 | `51f0e62895f26dcacf4cb55f99182bad1adb7bcb4de3b823bbbfc200112933ab` |

`receipt.json` is the portable source/outcome/limit summary. `raw-members.json`
records the exact size and SHA-256 of every member. The initial compressed archive
is unchanged from its original preservation. The follow-up uses deterministic
gzip and tar metadata. All members are regular files with unique relative paths.

The captures retain original result JSON, stdout/stderr, staged manifests and
locks, owner/preflight records, and exact measured controller/plan source. Raw
temporary paths remain verbatim to preserve byte hashes; the index and receipt
use portable relative member names. No archived source needs execution to audit
the data. For example, from this directory:

```sh
python3 - <<'PY'
import hashlib, json, tarfile
from pathlib import Path, PurePosixPath

index = json.loads(Path('raw-members.json').read_text())['archives']
for name, expected in index.items():
    data = Path(name).read_bytes()
    assert len(data) == expected['bytes']
    assert hashlib.sha256(data).hexdigest() == expected['sha256']
    actual = {}
    with tarfile.open(name, 'r:gz') as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            assert member.isfile() and not path.is_absolute()
            assert '..' not in path.parts and member.name not in actual
            raw = archive.extractfile(member).read()
            actual[member.name] = {
                'bytes': len(raw),
                'sha256': hashlib.sha256(raw).hexdigest(),
            }
    assert actual == expected['members']
    assert len(actual) == expected['memberCount']
    assert sum(item['bytes'] for item in actual.values()) == expected['rawBytes']
print('Both raw captures match every recorded byte digest.')
PY
```

Omitted payloads are the Bun executable, package tarballs, native host,
dependency directories, caches and full product source trees. The original
consumer manifest and cohort remain in #394; their hashes are retained here.
Full measured source inventories remain in both result files. This branch is
for draft archival publication and closure without merging; it changes no
runtime, workflow, dependency, pin, timeout or acceptance gate.
