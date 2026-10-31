# Bun AOT and native toolchain

**Status:** Exact versions and a working AOT+native host are not yet qualified. [BN0 #225](https://github.com/0xPlayerOne/bun-native/issues/225) pins the compiler, Rust/native renderer revision and per-platform prerequisites. This document is the intended toolchain contract.

## Bun application modes

| Mode | Purpose | Compiler/runtime behavior |
| --- | --- | --- |
| `bun run` | Development and fast edit loop | Executes application JS/TS with normal Bun runtime |
| `bun build --compile` | Conventional standalone executable | Bundles JS with Bun runtime and uses JIT at run time |
| `bun compile` | **Production Bun Native AOT target** | Experimental compile of supported JS/TS to machine code, with reduced Bun runtime and no JIT |

Bun AOT does **not** create native UI, compile JSX/CSS into Rust, remove GC or guarantee universal performance improvements. Native rendering comes from a separately compiled host. AOT currently targets the build machine's platform; build on target-native CI runners unless verified support changes.

Official references: [Compiler](https://bun.com/docs/compiler), [How `bun compile` works](https://bun.com/docs/compiler/internals), [Compatibility](https://bun.com/docs/compiler/compatibility).

## AOT compatibility and performance

- Type information and stable object shapes can improve AOT code quality. Review `bun compile --explain` output when supported to locate dynamic property access/slow paths, and measure rather than assume a faster result.
- `any`, broad type assertions, untyped packages, values crossing a JSON boundary and runtime-generated hot code may reduce optimization opportunities. Keep public/native boundaries precise and validate untrusted runtime values.
- Code dynamically evaluated with `eval`, `new Function` or `node:vm` may use an interpreter rather than compiled paths; profile package behavior before relying on it for hot UI logic.
- Compatibility of native addons, `bun:ffi`, macro/dynamic code and bundled assets with the exact AOT version must be tested under the **real shipped artifact**.
- AOT output still needs Bun runtime functions, an event loop, garbage collection and OS resources. Record the actual process tree, memory, startup and artifact size.

## Native host build

Framework contributors build/version the Rust GPUI host (or a documented native alternative) with an exact toolchain and per-OS resources. A consumer app install/build should normally download/use a compatible prebuilt artifact, not silently invoke Rust compilation. Pin host ABI, renderer source revision, Bun version, OS/CPU target and architecture in artifact manifests.

## Verification gates

1. Pin Bun compiler and native revisions; record OS/CPU and exact build commands (#225).
2. Launch a genuine native window under Bun development (#230).
3. Build the **same** app with `bun compile`, launch it, inspect missing JIT/browser payload and native bridge behavior (#227).
4. Test ABI versioning, lifecycle, resource cleanup and bad inputs (#228/#232).
5. Measure equivalent dev/JIT/AOT/native workloads with raw samples and compiler diagnostics (#244).
6. Build independently for macOS, Windows and Linux and test clean-machine launch (#246).

Never promote a JIT build to meet an AOT milestone; never hold the project behind a human feasibility vote. Failures are engineering defects to fix and document.
