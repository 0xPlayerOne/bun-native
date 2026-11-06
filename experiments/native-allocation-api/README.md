# Native allocation diagnostic crate

`bun-native-allocation-diagnostic` is the standalone, standard-library-only Rust
crate behind the [selected native allocation diagnostic](../../benchmarks/native-allocations/README.md).
It is Linux GNU only, is its own Cargo workspace, and is not a dependency of the
production host, the frameworks or the root Cargo workspace. The diagnostic stays
disabled unless `BUN_NATIVE_ALLOCATIONS=1`.

- `src/lib.rs`: initialization and the selected-interval gate.
- `src/abi.rs`: the Heaptrack 1.5.0 FFI declarations and `dladdr` library ownership checks.
- `src/config.rs`: the explicit environment configuration, its validation and the preload re-execution.
- `src/selection.rs`: the fixed request-ID phases and selected-request validation.
- `examples/selection-control.rs`: the owned-process control executable.

## Check the crate

These are the commands the Bun Native workflow runs for this crate. They need the
repository-pinned Rust toolchain but no GPUI build, display or profiler:

```sh
cargo fmt --manifest-path experiments/native-allocation-api/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path experiments/native-allocation-api/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path experiments/native-allocation-api/Cargo.toml --all-targets
```

## Run the bounded control

`benchmarks/native-allocation-control.py` compiles this crate as a hashed rlib with
the pinned `rustc`, builds `examples/selection-control.rs` against it and runs the
eight predeclared cases under the installed, hash-verified Heaptrack library. The
output directory must not exist yet. `--library` selects another absolute Heaptrack
preload path; it defaults to `/usr/lib/heaptrack/libheaptrack_preload.so`:

```sh
python3 benchmarks/native-allocation-control.py --output /absolute/new-control-output
```

`benchmarks/allocation-phases.py` then uses that control's `result.json` to prepare
the historical host patches. See the
[diagnostic guide](../../benchmarks/native-allocations/README.md) for the exact
library hash, the required outcomes and the patch-preparation command.
