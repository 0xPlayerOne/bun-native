# Linting generated projects

`native lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter) on a Bun Native project. `native check` runs it as a third step after the type checker and the formatter check. This page covers the consumer lint step from [BN5 #220](https://github.com/0xPlayerOne/bun-native/issues/220). For the other project commands, see the [CLI reference](developer-tooling.md).

```sh
bun run native lint apps/my-app
bun run native check apps/my-app   # typecheck, format check, then lint
```

Both commands print each step's output followed by `lint: passed` or `lint: failed`. A failed step exits with status 1. Every step in `check` still runs when an earlier one fails. Generated projects (Solid or React, TypeScript or JavaScript, checkout or standalone) have a `lint` script that calls this command. Their `check` script still runs only the type checker.

## Which oxlint runs

The CLI always runs its own pinned oxlint under the running Bun (`bun --no-install <oxlint bin>`). It never uses an `oxlint` on `PATH` and never installs anything. The pin is the root `oxlint` devDependency in `package.json`, currently `1.90.0`:

- **Checkout projects** use the checkout's installed `node_modules/oxlint`.
- **The standalone CLI package** imports `oxlint/package.json`, so the package-set producer records `oxlint` as a dependency of `@bun-native/cli`, using that same pin.
- **Generated standalone projects** also declare `oxlint` as an exact devDependency. Their seeded `bun.lock` locks `oxlint` and every `@oxlint/binding-*` platform package with registry integrity, and the offline install selects the binding for the current platform. Lint therefore needs a pinned package cache that contains `oxlint`, just like the other third-party packages.

`tests/tooling/cli-lint.test.ts` fails if the checkout pin, the installed version, the CLI package dependency and the consumer devDependency or lock entries disagree.

## Rules and configuration

When the project directory has no `.oxlintrc.json`, the CLI passes the repository's `.oxlintrc.json`. Those are the template rules, and they are packaged with the CLI source closure the same way the formatter style is. They enable the `correctness` category, turn off `suspicious`, and make `no-debugger` an error. A project `.oxlintrc.json` replaces these rules entirely. JavaScript/TypeScript oxlint config files are not discovered. `--deny-warnings` is always passed, so a warning fails the step.

Output uses oxlint's `unix` format with `NO_COLOR=1`. Each finding appears as `path:line:column: message [Severity/plugin(rule)]` with a project-relative path, followed by a problem count. It contains no timings or colour codes, so the same sources always produce the same report. For example:

```text
bad.ts:2:3: `debugger` statement is not allowed [Error/eslint(no-debugger)]

1 problem
lint: failed
```

## What is never linted

- `dist/`, `.bun-native/` and `node_modules/` are always ignored with explicit patterns. They hold default AOT build output, development bundles and installed dependencies. The patterns apply even if the project `.gitignore` no longer lists these directories.
- In a standalone project, `vendor/**` is also ignored. It holds the digest-verified package archives and their canonical manifest, and these are never linted or formatted. A checkout project's `vendor/` is ordinary project source and is linted.
- oxlint also honours the project's ignore files. As with the formatter, a checkout project placed inside a directory that the checkout's `.gitignore` excludes has no lint targets, and the step fails with oxlint's "No files found to lint" message.

## Verification and limits

These commands were run only on Linux x64, with the pinned Bun `1.4.4-canary.1+da867c60b`:

- `bun test tests/tooling/cli-lint.test.ts` scaffolds all four checkout templates and requires `lint: passed` from both the CLI and each `lint` script. It requires the exact deterministic report and status 1 for a deliberate `debugger` file from both `lint` and `check`. It also checks the ignore patterns, project-config precedence, standalone `vendor/` exclusion, and pin agreement across the checkout, CLI package and consumer lock.
- The Linux native workflow's standalone consumer cohort (`tests/native/cli-standalone.py prepare`) runs `bun --no-install run lint` in each of the four installed external consumers. It requires a fixed count of four such commands. That hosted run is the evidence for the installed-package path. A local test does not replace it.

macOS and Windows lint behaviour is not verified here. oxlint ships native bindings for those platforms, but no lint run on them is claimed. Type-aware oxlint rules (`--type-aware`, `oxlint-tsgolint`) and automatic fixes (`--fix`) are not offered.
