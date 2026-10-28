# Formatting

One checked style for maintained source, with separate native-language formatters.

**Tools:** Bun 1.4.4's built-in formatter, Ruff 0.15.22, and the existing workspace Rust toolchains.
**Policy:** Formatting failures fail validation; historical evidence is not rewritten.

## TypeScript, JavaScript, configuration, and documentation

```sh
bun run format
bun run format:check
bun run check
```

`format` writes Bun's built-in formatting. `format:check` is read-only and fails on drift.
`check` runs that gate first, followed by Bun-native type checking, lint, AST
boundaries, tests and builds. The hosted portable/full workflows already run
`check`, so formatting cannot be skipped by those paths. Ordinary automatic CI
remains subject to its existing pause and draft policies.

The scripts run Bun's built-in formatter and explicitly select
`.oxfmtrc.json`, avoiding nested-configuration discovery. Style is two spaces,
single quotes, no semicolons, a 100-column print width and LF endings. Import and
package-key reordering are disabled; embedded fixture strings are not reformatted.
This is formatting, not a migration to another package manager or formatter.

The existing staged-file commit hook remains change-aware. A fast edit does not
rerun every native build. Full-repository formatting is enforced by `check`.
Foundry sync also formats its managed output after applying the Bunly overlay,
so generated policies and configuration remain stable under repeated syncs.

## Python and Rust contributors

The JavaScript formatter does not replace the native-language formatters:

```sh
python -m pip install -r requirements-format.txt
bun run format:python
bun run format:native
bun run format:all:check
```

`format:python:check` uses the same Ruff configuration without modifying files.
The hosted portable lane installs the pinned formatter and runs that check.
`format:native:check` checks both Cargo workspaces with their declared toolchains;
native CI checks Rust formatting before its builds. These contributor tools are
not required merely to format TypeScript or consume a prebuilt application.
`format:all` applies all three formatters for contributors with all tools installed.

## Intentionally preserved files

`evidence/**` is excluded because reports and manifests retain exact measured
bytes and hashes. `.bunly/**`, dependencies, build output and other Git-ignored
scratch are not source-formatting targets. Existing generated Foundry exclusions
remain in place. No maintained package, test or script directory is excluded.
Configure an editor's formatter to use the repository formatting configuration; an
editor setting is not a substitute for the CLI gate.
