# Native allocation diagnostics

The native allocation runner profiles the **actual GPUI host** with the standard
[Heaptrack](https://github.com/KDE/heaptrack) preload library. It drives the
existing public lifecycle fixture through the existing Linux input controller:
one OS click, 1,000 subtree create/update/delete cycles, 3,000 listener
registrations, final native paint and OS close. It retains the ordinary ownership
and cleanup assertions. No allocator implementation or rendering substitute is
introduced.

This is an instrumented diagnostic. Its timings and RSS must not be combined with
the uninstrumented startup/idle baseline or interpreted as production throughput.
Native paint evidence remains enabled, so its allocations are included too.

## Reproduce on Ubuntu 24.04

Use the already-built host and pinned Bun from the normal native validation job.
Install the small CLI package; the separate Heaptrack GUI is unnecessary:

```sh
sudo apt-get install --no-install-recommends heaptrack binutils
```

The remaining Xvfb, DBus, Mesa, Openbox and input dependencies are the ordinary
[native test prerequisites](../tests/native/README.md). Run from the repository
root, using fresh output directories:

```sh
xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- \
  bash scripts/quality/native-linux-session.sh "$PWD/evidence/allocation-session" -- \
  python3 scripts/quality/native-allocation-linux.py \
    --output "$PWD/evidence/native-allocation" \
    --host "$PWD/target/release/bun-native-host" \
    --host-profile release --mode development -- \
    bun tests/native/public-lifecycle.ts
```

Create the parent `evidence` directory first. The runner creates each final output
directory and refuses to reuse it. `--host-profile` records the explicit build
profile; it does not compile the host or infer the profile from its filename.
An alternative package prefix can be supplied with `--heaptrack-prefix`; its
dependent shared libraries must be resolvable in the caller's environment.

The stock `heaptrack` shell frontend writes status to stdout. The native protocol
also uses stdout, so the runner creates a small, hashed, exec-only wrapper. That
wrapper sets Heaptrack's standard `LD_PRELOAD` and `DUMP_HEAPTRACK_OUTPUT` values
for the selected host, without loading the library into Bun or the wrapper's
Python interpreter. The wrapper emits no protocol output. During the run, the
controller verifies the launched descendant's PID/start identity, actual
`/proc/PID/exe`, and mapping of the selected profiling library.

The runner records hashes of the real native executable, generated wrapper,
preload library, Heaptrack interpreter and analyzer, GNU Rust demangler, and
relevant source/configuration files. It checks that those files stayed unchanged
through the run. `--mode aot` is only a label for the application command; the
profiler reports `aotVerifiedByProfiler: false`. AOT qualification still belongs
to the separate compiler manifest and binary inspection.

## Artifacts and bounds

`result.json` links the profile, exact tooling/source hashes and native lifecycle
result. The nested `lifecycle` directory preserves native input/paint evidence,
screenshots, application ownership observations and cleanup results.

Heaptrack first writes a raw trace with a 64 MiB file limit. The wrapper restores
the default `SIGXFSZ` disposition before exec, so hitting that limit terminates
the host and fails the lifecycle instead of accepting a truncated trace. Stricter
inherited file limits are preserved. The runner checks the top-level profiling
files' total size while recording and interpreting, and applies bounded
deadlines. The nested lifecycle evidence has the input driver's separate log
bounds. After interpretation, it replaces the raw file with
`native.heaptrack.gz`, retaining the original raw hash and size in the report.
The compressed trace contains the allocation events and resolved stacks and can
be reanalyzed with the same Heaptrack version.

`summary.txt` contains ten allocation-call hotspots, ten peak-memory callsites,
and ten temporary-allocation hotspots with representative stacks. Backtrace
merging is disabled because Heaptrack documents that merged peak values are not
exact. `summary-demangled.txt` resolves Rust v0 names with GNU `c++filt` without
rebuilding the host. `allocation-sizes.tsv` contains requested allocation size in
bytes and observed count. Text outputs have a 4 MiB file limit.

An initial diagnostic confirmed that an optional full expanded stack export
exceeded 64 MiB. That derivative is deliberately omitted: the compact complete
trace and bounded hotspot stacks retain the useful evidence without that large
text artifact. The failed attempt remains a failed diagnostic, despite its
native lifecycle checks having passed.

## Initial measured result

The checked-in [diagnostic summary](results/native-allocation-linux-dev.json)
records one successful Linux software-GPU run with the corrected development
host `55d2b9312529a01ccc3c4720f03040c4d685e7d51d9b7ece160f8b8e64ad7a49`,
Heaptrack 1.5.0 from Ubuntu package `1.5.0+dfsg1-2ubuntu3`, and GNU binutils 2.42.
This is a development-host observation; release-host CI records a separate
artifact and result.

The temporary environment containing this original run was subsequently
recycled. The checked-in summary and recorded hashes survive; its raw compressed
trace, full stack reports and screenshots are no longer available locally. A
fresh hosted CI run must regenerate and retain those artifacts. The runner's
subsequent boundary-hardening tests are headless process checks, not another
native profile or evidence that the historical artifact hashes match new output.

| Observation                                              |          Result |
| -------------------------------------------------------- | --------------: |
| Allocation-function calls                                |         760,502 |
| Temporary allocation calls, as classified by Heaptrack   |          88,675 |
| Requested sizes 0–64 bytes                               |   431,867 calls |
| Requested sizes 65–256 bytes                             |   195,851 calls |
| Requested sizes 257–4,096 bytes                          |   127,349 calls |
| Requested sizes above 4,096 bytes                        |     5,435 calls |
| Peak traced heap, Heaptrack display units                |          83.00M |
| Instrumented host RSS, Heaptrack display units           |         187.25M |
| Allocations outstanding at exit, Heaptrack display units |         625.95K |
| Complete compressed trace produced                       | 3,126,788 bytes |

The size histogram sums to the reported 760,502 calls. The largest individual
callsite by count had 26,019 allocations on the native command-reader path through
JSON map-key string deserialization. Other prominent stacks include owned JSON
string/value construction, tagged command/operation content conversion, and
JSON object storage growth. These are measured candidates for a subsequent
parser allocation comparison. The current parser intentionally preserves the
same duplicate-property and integer-spelling semantics as JavaScript; an
optimization must retain those contracts and the shared negative corpus.

The native fixture completed all 1,000 cycles, reported all six ownership counts
at zero after OS close, and exited without retained or unreaped child processes.
Those checks establish the exercised lifecycle behavior. They do not turn
Heaptrack's outstanding-at-exit quantity into a confirmed leak diagnosis.

The summary and original trace fingerprint survived an executor recycle, but
that local temporary trace is no longer available. Treat the values above as
historical observations. The required hosted native job regenerates and retains
the complete trace for its own exact release host and source; it does not relabel
the old summary as current release evidence.

## Interpretation limits

The profile covers the host's entire lifetime, including platform initialization,
software rendering, the workload, evidence logging and shutdown. Its total
allocation count cannot be divided by 1,000 and presented as the isolated cost of
a lifecycle operation. Bun heap objects are observed separately by the lifecycle
fixture; they are not included in this host profile.

Heaptrack records calls to intercepted heap allocation functions. GPU memory,
stack memory, direct mappings and allocation pools that bypass those functions
are outside this measurement. An allocation that remains at process exit may be
a platform cache or process-lifetime object, so the report preserves Heaptrack's
original label with an explicit qualification. The existing host retains symbol
names but omits debug information; source-line and inline attribution are
incomplete, and stripped external libraries may retain unresolved addresses.

The standard tool's scope and Rust-symbol requirements are described in its
[upstream documentation](https://github.com/KDE/heaptrack#heaptrack-with-rust).
Use repeated, artifact-bound release runs and targeted before/after comparisons
before claiming an optimization or general allocation ceiling.
