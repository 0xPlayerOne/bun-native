# Bun Native implementation handoff

## Current branch state

The BN0 workspace replacement removes the Bunly runtime and browser renderer.
The initial source is a portable TypeScript native-pipe framing package, strict
package-boundary checks, and a Rust workspace introduced with the native host.
No old CEF result qualifies this implementation.

## Removal inventory (#251)

The baseline is `202e2d79299c1ed6e40627aa2ec81a9865bafe1f`.

| Area                                                  | Decision         | Reason                                                                           |
| ----------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `packages/{artifacts,cli,client,contracts,runtime}`   | Replace          | Browser runtime APIs, CEF distribution and obsolete Bunly contracts              |
| `native/{cef,cef-host,host-probe}` and old Cargo lock | Replace          | CEF implementation and legacy N-API experiments do not implement GPUI            |
| `examples/*`                                          | Replace          | Browser/HTML, terminal and old host fixtures                                     |
| `tests/*`, old `scripts/*`                            | Replace          | Assertions and qualification tied to removed runtime                             |
| `benchmarks/*`, `evidence/*`                          | Replace          | Historical CEF/competitor workloads and measurements                             |
| `provenance/*`                                        | Retire           | Removed source/dependency inventory; current attribution remains in root notices |
| Python manifests, browser TS config, old Cargo flags  | Delete           | No active consumer in the new implementation                                     |
| CEF/M1–M6/benchmark Actions                           | Replace          | Native validation must execute new code                                          |
| Code Foundry draft/release policy and root license    | Reuse            | Repository workflow and attribution remain useful                                |
| Bun Native architecture/quality/vision docs           | Reuse and update | Current product and engineering contract                                         |

Removed implementation remains in Git history. No compatibility API or browser
fallback remains in the active packages.

## Immediate implementation sequence

1. [#225](https://github.com/0xPlayerOne/bun-native/issues/225): verify and pin
   the actual Bun AOT compiler, Rust and GPUI. Initial inherited tool versions
   are development bootstrap only until this work qualifies them.
2. [#230](https://github.com/0xPlayerOne/bun-native/issues/230): connect Bun to
   the GPUI host, render a real window, click, edit text, close and relaunch.
3. [#227](https://github.com/0xPlayerOne/bun-native/issues/227): compile that
   same application with machine-code `bun compile`, run and inspect it.
4. [#226](https://github.com/0xPlayerOne/bun-native/issues/226): maintain the
   concrete integration record and fix reproducible blockers.
5. [#258](https://github.com/0xPlayerOne/bun-native/issues/258): extend code
   health checks and capture performance only after native behavior is correct.

## Validation meaning

`bun install --frozen-lockfile`, `bun run check`, and Rust protocol checks test
source, framing and dependency boundaries. `bun run build` emits JS modules and
is explicitly not an AOT executable. Initial unit tests are headless; they do
not prove GPUI rendering, input, GPU acceleration or AOT compatibility.

Native window, AOT, framework renderers, packaged releases and platform support
remain unaccepted until their dedicated evidence exists. Work on BN1 contracts
may proceed alongside compiler integration; milestone closure may not.

See [testing](testing.md), [toolchain](toolchain.md), and the issue/PR logs for
exact command results. Keep this document current as each implementation lands.
