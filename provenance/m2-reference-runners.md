# M2 reference-runner provenance

**Scope:** Benchmark adapters and inspection utilities; no upstream runtime/core code copied.

The wrapper implementations, stage validator, archive verifier, C ABI test fixture,
and Python/TypeScript tests are original Bunly code. Upstream packages remain
separate installed benchmark dependencies and retain their own distribution notices.

| Reference  | Inspected commit / source                                                               | Use                                                                             |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Mirin      | `c60fa09a7ae94368e22188cb8ff0b38a910a9f24`                                              | Public app/window API, package manifests, build CLI and platform bundle layouts |
| Butter     | `a735ddf2eac8f4fe4a98370fc4ccf4373db797d9`                                              | Exported window API, CLI compile command, output path and bootstrap behavior    |
| Electrobun | `c4bbeca07829d9b1634d31598ef6091fb19ace2a`                                              | Existing pinned application layout and qualifier                                |
| CEF        | `include/cef_version_info.h`, inspected blob `00008460b1fad93d66deb4eb5c54059a16a76b59` | Public version-query function signatures; no header copied                      |

Primary source paths:

- `Netko-Labs/mirin/packages/mirin/src/app/facade.ts`
- `Netko-Labs/mirin/packages/mirin-cli/src/build.ts`
- `Netko-Labs/mirin/packages/mirin-cli/src/bundle/{linux,windows}/app.ts`
- `wess/butter/src/runtime/index.ts`
- `wess/butter/src/cli/{index,compile}.ts`
- `chromiumembedded/cef/include/cef_version_info.h`

These source references describe inspected behavior, not executed compatibility.
Exact manifest/entry/lock hashes collected by the adapters do not prove that an
installed registry package corresponds to these commits. Reports preserve that
source-authentication gap. No additional npm/native runtime is shipped in Bunly.
