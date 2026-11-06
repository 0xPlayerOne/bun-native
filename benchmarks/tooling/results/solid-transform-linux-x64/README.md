# Solid transform memory in the watch controller

Follow-up to the [allocator control](../../README.md) for
[#372](https://github.com/0xPlayerOne/bun-native/issues/372): after
`MIMALLOC_PURGE_DELAY=0`, does the Solid Babel universal transform
([`scripts/solid/transform.ts`](../../../../scripts/solid/transform.ts)) have a
causal, safe change that reduces the controller's resident memory over 401 edits?

**Result: no product change is justified.** Reusing the loaded Babel preset made
no measurable difference to RSS. The Babel stage does account for most of the
remaining Solid growth under purge 0. But the live JavaScript heap stays bounded,
so the growth is not a retained per-build object that a transform option could
release.

All records are on Linux x64 (6.18, 4 shared vCPUs, other builds running, 1-minute
load 1.0–3.3 during the runs), with the pinned Bun `da867c60`, source `b7d6eaf2`.
Every worker exited 0 and found its edit in every output. RSS is `VmRSS` in MiB;
the tables give medians of 3 interleaved fresh-process repeats at 401 builds.
Timings are noisy on this shared machine; RSS is the primary signal.

## Candidate: reuse the loaded preset

`transformSolid` passes a new preset options object on every call. Babel caches
preset descriptors, and the plugin instances they create, by option identity, so
every file in every rebuild re-runs `babel-preset-solid` and rebuilds the JSX DOM
Expressions plugin. The candidate hoisted the options to module scope:

```ts
const presets = [[solid, { generate: 'universal', moduleName: '@bun-native/solid', dev: false }]]
const parserOpts = { plugins: ['typescript', 'jsx'] }
// transformSync(source, { filename, babelrc: false, configFile: false, sourceMaps: false, parserOpts, presets })
```

With this change, `loadOptions` returned the same plugin instance on every call, as
intended. Output was byte-identical: the 15 repository Solid `.tsx` sources, three
rounds each, and the `solid-workspace` and `solid-counter` bundles all matched.

Two matched controls ran the same harness worker in two checkouts, `b7d6eaf2` (base)
and `b7d6eaf2` plus this change (shown as `changed`/`hoist`; its local commit
`23c6414` was not kept). The variant order alternated between repeats.

[`preset-reuse-full.jsonl`](preset-reuse-full.jsonl) uses the production
`bundleProject` path through the `controller-allocator.ts` worker:

| Purge delay | Variant | First build | After build 401 | Final range | Median ms | p95 ms |
| ----------- | ------- | ----------: | --------------: | ----------: | --------: | -----: |
| default     | base    |        82.3 |           170.0 | 166.0–174.2 |       9.0 |   15.1 |
| default     | reuse   |        82.1 |           170.8 | 166.4–171.6 |       8.8 |   13.7 |
| 0           | base    |        74.1 |           123.6 | 123.5–125.3 |      11.7 |   18.6 |
| 0           | reuse   |        73.6 |           123.2 | 121.7–123.7 |      11.2 |   17.8 |

[`preset-reuse-transform.jsonl`](preset-reuse-transform.jsonl) runs only the
transform, through the `transform` worker of
[`controller-solid-stages.ts`](../../controller-solid-stages.ts):

| Purge delay | Variant | First build | After build 401 | Final range | Median ms | JS heap |
| ----------- | ------- | ----------: | --------------: | ----------: | --------: | ------: |
| default     | base    |        70.3 |           130.2 | 128.6–134.0 |       2.4 |    17.3 |
| default     | reuse   |        70.4 |           128.9 | 127.8–130.2 |       2.0 |    17.3 |
| 0           | base    |        67.5 |           120.0 | 119.9–121.5 |       2.5 |    17.2 |
| 0           | reuse   |        67.7 |           119.4 | 118.9–122.2 |       2.3 |    16.6 |

All differences fall inside the repeat ranges. Preset construction is a small,
short-lived allocation next to parsing and traversing the module, so reusing the
preset does not change resident memory.

The other options in the brief are already in place or do not apply:
`configFile: false`, `babelrc: false` and `sourceMaps: false` are already set.
`cloneInputAst` only affects `transformFromAst`, and `transformSync` already
returns no AST by default. Neither module keeps per-build closures or Maps: the
Bun.build plugin and its `onLoad` closure are local to each `buildSolid` call.

## Where the remaining Solid growth is

[`controller-solid-stages.ts`](../../controller-solid-stages.ts) runs one stage
per fresh process ([`stages.jsonl`](stages.jsonl)):

- `full` is the production `bundleProject` path.
- `transform` is only `transformSolid`, with no Bun.build or output.
- `bundle` uses the production Bun.build settings, with the template transformed
  once at startup, so no Babel runs per edit.

| Purge delay | Stage     | First build | After build 401 | Median ms | JS heap | JS heap capacity |
| ----------- | --------- | ----------: | --------------: | --------: | ------: | ---------------: |
| default     | full      |        83.6 |           173.7 |       9.6 |    26.1 |             40.5 |
| default     | transform |        70.9 |           127.7 |       2.3 |    16.9 |             42.6 |
| default     | bundle    |        80.9 |           138.5 |       5.8 |    16.4 |             18.8 |
| 0           | full      |        75.6 |           128.1 |      11.8 |    27.0 |             41.2 |
| 0           | transform |        68.1 |           123.1 |       2.4 |    17.3 |             44.3 |
| 0           | bundle    |        73.3 |            87.4 |       9.9 |    18.0 |             20.5 |

Under purge 0, bundling without Babel grows about 14 MiB over 400 edits. The
transform alone grows about 55 MiB, and the full path about 52 MiB. The Babel
stage therefore accounts for most of the remaining Solid growth. Its live JS
heap stays near 17 MiB, while JS heap capacity grows to about twice that.

Single exploratory runs, all under purge 0 ([`probes.jsonl`](probes.jsonl)):

- **Growth is front-loaded.** The transform alone reached 100.4 MiB after 50
  edits, 124.8 MiB after 401 and 135.3 MiB after 1,601. The full path went from
  127.1 MiB at 401 builds to 137.9 MiB at 1,601. The live JS heap stayed at
  17–30 MiB throughout.
- **JIT tiers account for part of it.** With the DFG tier off
  (`BUN_JSC_useDFGJIT=0`), the transform alone ended at 90.8 MiB, against 124.8
  MiB. With only FTL off it ended at 111.1 MiB. These are diagnostics, not
  proposed settings: turning DFG off nearly doubled the median transform time.

The evidence fits JavaScriptCore warming up on Babel's large code base, plus heap
capacity that the engine keeps after collectable transform garbage. It does not
fit a transform-owned retainer, which would grow the live heap. These runs do
not separate JIT memory from heap capacity precisely. No heap snapshot was
taken, and a forced collection is not a fix. Neither result says anything about
macOS, Windows, native watch RSS or a long-session plateau.

## Reproduce

```sh
# Stage decomposition (fresh process per case, interleaved, both purge policies).
bun benchmarks/tooling/controller-solid-stages.ts --builds 401 --repeats 3

# Preset reuse: apply the candidate above in a second checkout of the same source, then
# alternate the worker between checkouts for each policy, e.g.
env -u MIMALLOC_PURGE_DELAY bun "$CHECKOUT/benchmarks/tooling/controller-allocator.ts" --worker solid --builds 401
MIMALLOC_PURGE_DELAY=0 bun "$CHECKOUT/benchmarks/tooling/controller-solid-stages.ts" --worker transform --builds 401
```
