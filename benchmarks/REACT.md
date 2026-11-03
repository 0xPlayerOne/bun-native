# React native update and lifecycle diagnostic

`benchmarks/solid/react.tsx` adapts the shared `MeasuredView` workload to the actual
React reconciler and public native core. `workload.ts` is the same framework-neutral
workload used by the Solid and direct-core experiments. Its current directory is
historical; the React adapter imports no Solid runtime. Keep the workload and its
failure oracles shared when the adapter branches are integrated.

The required native Linux job runs this diagnostic with the same **release host**
already built for the other native tests. It runs development Bun and a separately
compiled and inspected machine-code AOT application from the same generated
module, with explicitly selected production React/reconciler in both modes.
The committed
[local evidence](evidence/react-linux-lifecycle.json) uses a **development-profile**
protocol-2 host, Linux X11 and Mesa llvmpipe. It is not hosted release evidence.

## What is verified

Each mode uses 32 keyed rows and performs these phases in one real native window:

| Phase                 | Workload                                   | Required mutations and ownership                                               |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| Warm-up               | 20 acknowledged label updates              | Outside the reported mutation phases                                           |
| Individual updates    | 1,000 state changes                        | Exactly 1,000 native property updates                                          |
| Coalesced updates     | 1,000 values submitted in groups of ten    | Exactly 100 native property updates                                            |
| Keyed rotations       | 1,000 rotations of the same row identities | Exactly 1,000 moves, no creates or deletes                                     |
| Lifecycles            | 1,000 mount/update/dispose cycles          | One acknowledged label update per cycle; 32,000 row owners created and cleaned |
| Retention observation | 3,000 WeakRef probes                       | No target observable at the final fixed collection checkpoint                  |

The lifecycle probes reference each React render root, content node and native
listener. The workload performs exactly two collection observations: a timer turn
and forced collection, then one empty public-core queue fence and a second timer
turn/forced collection. The fence sends no native command. It never retries
collection until the result becomes zero. Both observations are retained even if
only the first still sees a target. Any surviving target at the second observation
fails the diagnostic. Every cycle must leave only the window root; after shutdown,
all six public ownership/queue counts must be zero.

These are bounded retention observations. A zero count is not proof of long-term
leak freedom, and a still-observable target does not by itself identify a retaining
root or distinguish application ownership from conservative runtime roots. Earlier
direct-core AOT retention failures remain separate evidence; a passing React run
does not resolve them.

## Native calibration and timing scope

The controller first runs a separate small calibration in each mode, with ten
individual updates, ten keyed rotations and two lifecycle cycles. Native evidence
must contain the complete expected initial and final trees, including row identity
and order, and the actual renderer's GPU description. This is a GPUI paint traversal
observation, not a display-presentation timestamp. The calibration log is bounded
to 4 MiB. Its timing is excluded from workload timing.

The full workload disables native paint evidence. Each sample measures application
submission through public-core acknowledgement; it includes React scheduling,
the shared native planner, validation, IPC and native command work. The separate
synchronous-submission samples do not include deferred React planning. Neither
interval measures input-to-presentation latency, GPU frame time or peak capacity.

Sparse full-GC `bun:jsc` checkpoints retain live object categories, JSC heap bytes
and application RSS outside timed phases. They do not measure cumulative
allocations, the native host's RSS or GPU memory. Timing arrays and WeakRef
instrumentation remain live at the final heap checkpoint and are disclosed in
the report.

The historical local evidence contains one full trial per mode. Those development
and AOT runs used different dependency build conditions; they predate the current
matched production-framework module recipe and are not a controlled compiler-only
comparison. Their source/artifact records are preserved unchanged. No performance budget, speedup
claim or framework ranking is inferred from these samples. A matched, repeated
release-host comparison with Solid and direct core remains part of #236; it must
keep equivalent workloads and resolve any failing retention oracle before accepting
comparison results.

## Reproduction

Use the repository-pinned Bun and an explicit prebuilt host. This does not rebuild
native code. Use a fresh output directory, retain both mode reports, and state the
actual host profile:

```sh
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
export BUN_NATIVE_HOST_PROFILE=release
mkdir -p .bun-native
run_dir=$(mktemp -d "$PWD/.bun-native/react-workload.XXXXXX")
bun experiments/aot-gpui/build-window.ts --source "$PWD" \
  --host "$BUN_NATIVE_HOST" --host-profile release --entry react-workload \
  --outdir "$run_dir/aot-package"

nonce=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
timeout --kill-after=5s 150s xvfb-run --auto-servernum \
  --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/development-session" -- bun "$run_dir/aot-package/development/application.js" \
  --host "$BUN_NATIVE_HOST" --output "$run_dir/development.json" \
  --nonce "$nonce" --mode development \
  --iterations 1000 --rotations 1000 --mounts 1000 --rows 32

nonce=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
timeout --kill-after=5s 150s xvfb-run --auto-servernum \
  --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/aot-session" -- "$run_dir/aot-package/react-workload" \
  --host "$BUN_NATIVE_HOST" --output "$run_dir/aot.json" \
  --nonce "$nonce" --mode aot \
  --iterations 1000 --rotations 1000 --mounts 1000 --rows 32
```

For each mode's separate calibration, use a new nonce, output/session paths and
`--iterations 10 --rotations 10 --mounts 2 --rows 32 --calibration`; set
`BUN_NATIVE_EVIDENCE_LOG` to an absolute JSONL path and
`BUN_NATIVE_EVIDENCE_NONCE` to that nonce. The CI recipe includes both calibration
commands and preserves all reports, raw samples, heap categories, logs and compiler
manifests. `--mode aot` is only a declaration; the build helper's executable
inspection, exact artifact hash and launch path provide the separate AOT evidence.

The native host, compiler and all compiled source files must still match their
recorded hashes after the run. A changed source snapshot or workload needs fresh
evidence. The original mount/dispose-only trials are preserved separately from
the later mount/update/dispose workload and are not silently relabeled.
