# Bun-native tooling

> Historical evidence redaction: Bun runtime version identifiers are replaced with `VERSION_REDACTED` in retained text and compressed captures. Measurements and outcomes remain unchanged. Archive digests and byte counts identify the redacted captures; source digests recorded inside historical evidence continue to identify the original captured source when that source text has been redacted.

Measured developer-tool improvements without changing the desktop trust boundary.

**Measured checker runtime:** Bun 1.4.4; repository formatter/tooling: Bun 1.4.4;
embedded and reference TypeScript 7.0.2.
**Scope:** Type checking, package/example builds, boundary inspection, and maintainer file inventories.
**Evidence:** `evidence/bun-tooling-local.json`. These are descriptive local timings, not controlled M9 performance results.

## Native type checking

The normal project commands now invoke Bun's built-in checker:

```sh
bun run typecheck
bun run typecheck:browser
bun run check
```

Their underlying commands are `bun --check --tsconfig-override tsconfig.json` and
`bun --check --tsconfig-override tsconfig.browser.json`. The explicit invocation
matters: on the pinned runtime, `bun check` resolves our package's `check` script.
The currently documented `--no-script` spelling did not bypass that script in
our 1.4.4 executable. Do not replace the qualified command with that spelling.
The browser configuration still has no Node/Bun ambient globals. The full check
sequence and AST security boundary checks remain enabled.

Keep `typescript@7.0.2` for editor tooling, the independent reference checker and
future declaration emission. Bun's checker does not emit declaration files.
The reference scripts run the pinned TypeScript launcher through Bun rather
than requiring Node to launch it:

```sh
bun run typecheck:reference
bun run typecheck:browser:reference
bun run qualify:typecheck
```

Qualification compares both complete project file sets, diagnostic source
identity/position/code and exit status. Its fixtures cover strict assignment,
unchecked indexed access, exact optional properties, unknown catch values,
overrides, unused variables, generated declarations, missing imports, parser
errors, `@ts-expect-error`, browser globals, DOM types, inherited configuration,
exclusions, and the package-script collision. Unbuilt project references and a
repaired reference graph are checked separately. It verifies that native
checking emits no files and removes its temporary fixtures on completion.

The 23-case qualification runs in the existing manual hosted workflow on every
selected platform, including its `portable` suite. It is intentionally not
part of the ordinary edit-loop command, where running both compilers repeatedly
would defeat the improvement.

## Builds and native file APIs

The fixed, independent package targets now overlap their `Bun.build` calls.
The workbench's Bun/browser entrypoints also build independently. Every owned
writer settles before success or failure is returned. Failed builds still fail;
the next successful build removes stale package and workbench output. Targets,
source maps and emitted code are unchanged; the actual 15-file output inventory
was byte-identical in paired measurements.

Boundary inspection uses bounded batches of at most 16 native `Bun.file().text()`
reads and native JSON reads for package manifests. The existing Oxc AST walker,
import rules, source-extension coverage and early pruning of generated/dependency
directories are retained. Diagnostics stay deterministic. No regex replaces AST
inspection, and no generic glob starts traversing browser or dependency caches.

Maintainer file inventories stream through `Bun.file().stream()` and
`Bun.CryptoHasher('sha256')`. Files are not buffered wholesale. Digests, ordering,
link handling and byte-accounting semantics remain unchanged. Additional size
and file-identity checks reject observed mutations. Duplicate-content grouping
appends to existing arrays rather than repeatedly copying a growing group.
This removes quadratic grouping work for duplicate-heavy asset inventories.
The inventory is not a sandbox against a hostile same-user filesystem race.

## Observed timings

The paired Mac measurements used one warmup, alternating order and six measured
repetitions for checking; build/boundary and synthetic inventory measurements
used eight. The workstation was not exclusively reserved and no background-load
or thermal gate was imposed. Raw samples, commands' relevant configurations and
source identities are retained in the evidence file.

| Operation                             | Previous median | New median | Interpretation                                            |
| ------------------------------------- | --------------: | ---------: | --------------------------------------------------------- |
| Root type check                       |        320.2 ms |   158.7 ms | About 2.0x faster in this local sample                    |
| Browser-only type check               |        125.3 ms |    71.6 ms | About 1.75x faster in this local sample                   |
| Boundary inspection                   |        120.5 ms |   103.3 ms | Lower local latency; unchanged AST rules                  |
| SDK/example build                     |         98.8 ms |    94.0 ms | Small, noisy difference; no material speedup claim        |
| 129-file / 65 MiB synthetic inventory |         50.8 ms |    49.8 ms | Essentially unchanged here, with stronger mutation checks |

The reference checker was launched through Bun for the comparison, not charged
an extra Node startup. Tests remain sequential. An experiment running all static
checks concurrently was not adopted: each native checker/linter can already
use multiple cores, and oversubscription is not a reliable optimization.

## Deliberate non-changes

The project retains Oxlint and uses Bun 1.4.4's built-in `fmt` for JavaScript,
TypeScript, CSS, HTML, JSON, YAML, and Markdown. Bun 1.4.4 remains the qualified
packaged desktop runtime; native CEF qualification lanes install that version
after portable repository checks. The Rust compiler and CEF version remain pinned.

The project already uses Bun's bundler, test runner, HTTP server, subprocess and
YAML APIs in their appropriate places. Native file reads do not justify replacing
exclusive filesystem creation, atomic rename, cryptographic verification, OS
sandbox observation or process-tree cleanup. Those mechanisms retain their
existing implementations. Browser-safe packages do not gain Bun dependencies.

This work does not claim faster desktop startup/rendering, reduced CEF bundle
size, lower application RAM, competitor superiority, or M4/M5 security/PTY
acceptance. Those need their respective workloads and platform qualification.

## Executed qualification

The complete local checkout passes 491 TypeScript tests and 145 Python tests,
plus browser-only checking, lint, builds, Foundry doctor, workflow syntax,
formatting and normal commit hooks. Eight new tooling tests cover output
identity, stale-file removal, failed-build cleanup/repair, cryptographic hashes,
duplicate groups, link policy, AST scanning and the native checker entrypoints.

Final-source portable run `39677300791` passes on Windows, Linux and macOS.
Each platform passes all 23 checker comparisons with the same 179 repository
source files and 12 browser files. Linux/macOS pass all 491 TypeScript tests;
Windows passes 487 with four explicit symlink-fixture skips. All three pass
145 Python tests. No native application capability is inferred from a skip.

Full native Linux/macOS jobs passed in run `39676452547`, executing clean
`f42917669f5c07c4f8e5c54c4374415db2bd0cb9`. Its first Windows job failed the
new comparison's path-prefix assumption; this failure is retained. The fix
normalizes actual files before containment/coverage comparison. It does not
accept an empty file set, suppress compiler errors, or change the compiler.

Full Windows run `39676950594` then passed from clean
`d75dbfee9fc36806df32ce8fae970e898911c190`; the only intervening code change
was that comparison helper. The native runtime, build and inventory code is
identical between these commits. Native qualification covered 12 Linux,
11 macOS and 10 Windows prebuilt cases, 100 lifecycle cycles and four actual
process faults per platform, with zero forbidden development-origin requests.
The runs retain standard deadlines and the existing browser sandbox policies.

Windows remains standard-user execution. These are hosted functional tests,
not native-hardware performance, physical input/DPI or production-signing
qualification. Automatic CI stays paused; all reported runs were explicit
manual dispatches. M4 was not advanced.
