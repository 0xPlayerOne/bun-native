# Pre-M4 foundation pass

Bounded native asset work, lifecycle qualification, and maintained regression checks.

**Baseline:** Merged PR #87, `bdf9c9e10fa4d30a43931aee794186c09e83bcf1`.
**Scope:** Packaged resource loading and qualification before native M4 renderer authority.
**Status:** Implementation and local validation in progress; platform evidence is recorded separately.

## Native packaged assets

Asset creation now builds a bounded response plan. Two background workers perform
file verification, and a deferred CEF continuation releases the response only after
the complete installed file matches its manifest hash. Full GET retains its verified
body; ranges retain only the requested bytes; HEAD and 304 retain no body. Each
worker reuses a 64 KiB verification buffer.

Admission is bounded across concurrent requests: 64 requests, 64 MiB of retained
body reservations, and a separate 64 pending-continuation limit. Queued cancellation
removes work immediately; running work remains charged until its actual allocation
is released. Shutdown fences callbacks and joins workers before CEF shutdown, with
a guard covering early startup errors. The CEF wrappers delegate to ordinary Rust
functions. See [native assets](native-assets.md) for invariants and precise limits.

## macOS helper lifecycle

The observer keeps the ordinary 500 ms descendant grace. A separate three-second
cleanup window requires the exact owned helper executable and full hash, fresh
process identity, and a private clone independently bound to the launched host.
The last-sample race is covered by a bounded same-user libproc inventory using the
kernel's retained original-parent unique ID. Process role text cannot establish
ownership. Completion requires both helper exit and removal of the exact clone.

The maintained qualifier runs prompt and deliberately delayed cleanup for retained
baseline and current apps, with every attempt preserved. Policy tests reject stuck,
substituted, foreign and misidentified helpers; post-exit resources remain visible.
See [macOS clone cleanup](macos-clone-cleanup.md). The real Mac reparenting check
and all 50 scoped lifecycle tests passed. Actual four-case qualification is recorded
separately and is required before treating issue #88 as resolved.

## Maintained regression commands

`bun run check:foundation` exercises deterministic ownership, queue and reservation
bounds, cancellation and malformed input. Its 131 tests also run within normal
validation. Python and Rust add native lifecycle and resource-invariant checks.

`bun run profile:foundation` preserves the message, structured RPC and cache
workloads with raw observations, seeded order and distribution summaries.
`bun run profile:foundation:cpu` adds Bun's machine-readable and Markdown CPU
profiles. `bun run profile:foundation:native --app PATH` measures a real prepared
CEF app under concurrent full, range, HEAD and conditional asset requests, including
fresh/reused profile startup and idle/active synthetic input-to-frame observations.
See [foundation performance](foundation-performance.md) for the methodology.

These are descriptive measurements with bootstrap mean intervals, not timing gates.
Fresh profiles do not establish OS cold-cache startup; synthetic DOM events do not
establish hardware input or compositor presentation latency. M4 renderer authority
and representative transport selection remain unfinished acceptance work.

## Packaging integrity

`packageCefRuntime` computes the compressed byte count and SHA-256 while gzip
output flows through the bounded stream pipeline. It returns a manifest only
when the source, compressor and destination have completed successfully, the
completed output is a regular file of the measured length, and the final source
inventory validation succeeds. Failed owned outputs are removed; an existing
output is never overwritten or removed.

The source inventory pass, pre-pack directory validation, per-file size/hash
checks during emission, production-runtime configuration checks, and post-pack
directory validation remain in place. They cover different source-mutation
windows and have not been removed as redundant.

The compressed digest now describes bytes emitted by gzip and accepted by the
writer. The former extra archive read described bytes read back from the output
path. Those are different guarantees: this optimization does not independently
check storage corruption or a same-length modification after the write. Neither
approach is an `fsync` or power-loss durability guarantee. The signed acquisition
path still verifies the received archive's exact size and hash before publishing
an installed runtime. Work assumes the existing private per-user filesystem
boundary; it does not promise protection from hostile same-user filesystem races.

The maintained tests independently hash and decompress captured output, exercise
real package/acquisition round trips, and reject source failure, late destination
failure, aborted writes and oversized compressed output. Metadata is withheld
until the writer's final completion. This removes one complete archive read; it
is a packaging I/O change, with no desktop-runtime speed claim.

## Actions runtime pins

Direct workflow actions were checked against upstream release commits and their
`action.yml` manifests. The following pins explicitly use Node 24:

| Action                               | Release  | Commit                                     |
| ------------------------------------ | -------- | ------------------------------------------ |
| `actions/checkout`                   | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-python`               | `v7.0.0` | `5fda3b95a4ea91299a34e894583c3862153e4b97` |
| `actions/upload-artifact`            | `v7.0.2` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
| `actions/cache`, `/restore`, `/save` | `v6.1.0` | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` |
| `oven-sh/setup-bun`                  | `v2.2.0` | `0c5077e51419868618aeaa5fe8019c62421857d6` |

The existing setup-bun pin already supported Node 24. The pinned Foundry release
and its reusable workflows stay unchanged. The application continues to use
Bun 1.4.3; Node 24 here is the Actions implementation runtime. Billing guards,
draft requirements, trigger conditions and hosted-run authorization are unchanged.
Local workflow syntax validation is not hosted execution.

Sources: [GitHub's Node 20 deprecation guidance](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/),
[checkout release](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-python release](https://github.com/actions/setup-python/releases/tag/v7.0.0),
[upload-artifact release](https://github.com/actions/upload-artifact/releases/tag/v7.0.2),
[cache release](https://github.com/actions/cache/releases/tag/v6.1.0), and
[setup-bun release](https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0).

## Advisory verification

Fresh `bun audit --json` requests for the root, Electron adapter, Electrobun
adapter and shared benchmark fixtures completed with exit code zero and empty
advisory objects on 2026-10-22. The prior timed-out attempts remain historical
unverified checks; the new results do not rewrite them. Application and benchmark
lockfiles were not upgraded as part of this pass. An empty advisory result means
no known findings from that check, not absence of vulnerabilities.

Both locked Cargo dependency audits completed with zero reported vulnerabilities
and no warnings. The complete Python requirements audit also reported no known
vulnerabilities. An initial Python audit invocation selected a virtual environment
without the audit module; the installed contributor audit tool was then used
successfully. The Git-history secret scan passed with the existing exact
historical exclusions. These checks do not establish native runtime security or
M4 renderer authority.
