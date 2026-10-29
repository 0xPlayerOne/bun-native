# Code Foundry

Reproducible repository policy without adding a desktop runtime dependency.

**Package:** `code-foundry@1.48.8`, development-only and exactly locked.
**Release source:** `945e548d1a1de5f6ca6195d245e9d82fc8e4ca63` (`v1.49.0`).
**Scope:** GitHub layout, generated policy, contributor hooks and CI configuration.

## Supported commands

```sh
bun install --frozen-lockfile
bun run foundry:sync
bun run foundry:doctor
bun run foundry:plan
```

Use the repository wrapper, not an unpinned global command or `--force`.
`foundry:sync` runs the installed upstream generator and then reapplies the
reviewed Bunly overlay. `foundry:init` provides the same path for initial setup.
The wrapper checks that the installed package, declared dependency and configured
release agree before invoking upstream. Updating Foundry requires reviewing its
release source and changing the pinned version/SHA together.

`foundry:doctor` verifies both upstream health and the repository-specific layout,
workflow pins, billing predicates and native-aware commit hook. A successful
upstream doctor alone is not evidence that the custom overlay is intact. The
pinned upstream doctor emits a tag-format warning for the immutable SHA. The
SHA was checked against the actual `v1.49.0` release ref; the warning is retained,
not hidden, while the doctor exits successfully.

## Canonical layout

GitHub policy lives in `.github/`: contribution and security policies, code of
conduct, CODEOWNERS, one pull-request template, issue forms and workflows.
`AGENTS.md`, README, license/notices and language toolchain configuration remain
at the repository root. There is no second root contribution guide or second bug
form. Bunly-specific guidance is outside upstream-managed document blocks, so
sync retains it.

Preflight rejects misplaced or incorrectly cased policy files, `.guthub`, nested
GitHub directories, symlinked output paths, case collisions, and duplicate issue
form names **before** invoking the generator. Conflicting authored files are not
automatically deleted: consolidate their content deliberately, then rerun sync.

The overlay also preserves the separate native/benchmark Dependabot roots,
Bunly-specific environment fields in the bug form, and exact reviewed Foundry
workflow/runtime SHA pins. Unknown conditions or upstream layouts fail for review
instead of silently overwriting authored behavior.

## Hooks and native workspaces

Sync enables the repository-local `.githooks` directory using upstream's chaining
mechanism. The previous machine-level hook directory is retained locally, and
other hook names delegate to it; no global hook setting is changed. Machine-local
delegates are ignored by Git.

The committed pre-commit gate uses Bun and preserves the installed Foundry
format/lint/type/Python checks. `scripts/native-pre-commit.ts` routes Cargo checks
to Bunly's independent workspaces rather than assuming a root Cargo manifest.
A failing check is not grounds to bypass hooks. Passing the change-aware hook is
not a substitute for the full validation and platform suites.

## CI policy

Automatic CI remains paused through `billing_paused: true` and the existing
`CI_BILLING_PAUSED` repository variable. The repository being public does not
implicitly resume every historical workflow. Manual native qualification is the
explicit, owner-authorized exception; see
[manual native qualification](manual-native-qualification.md).

| Checked-in pause | Repository variable                  | Automatic jobs            |
| ---------------- | ------------------------------------ | ------------------------- |
| `true`           | Unset or anything other than `false` | Skipped                   |
| `true`           | `false`                              | Original predicates apply |
| `false`          | Unset or anything other than `true`  | Original predicates apply |
| `false`          | `true`                               | Skipped                   |

Only the exact `github.event_name == 'workflow_dispatch'` predicate, accompanied
by a declared dispatch trigger, is exempt. An OR-expression cannot bypass the
billing guard. The overlay preserves these policies on every sync.

Code Foundry Draft Guard converts ordinary pull requests opened or reopened in
ready state to draft; an explicit Ready for review transition starts PR CI.
Bunly's custom PR checks follow the same `ready_for_review` and `synchronize`
triggers and require a ready PR at the job boundary. The optional OpenCode scan
also checks readiness independently of its detection job. The lightweight Draft
Guard and Draft Control jobs still run to enforce draft state and cancel earlier
runs. Release Please heads are excluded from ordinary Draft Guard and their
release workflow manages the readiness transition; a ready release PR receives
the same required checks. Push, scheduled and manual workflows retain their
existing triggers. The sync wrapper reapplies the scanner gate after generation.

The `release` feature enables automated GitHub release PRs, tags, and release
records. Bunly uses one root framework release and `v`-prefixed tag; its five SDK
package versions and public backend descriptor versions move together. Benchmark
fixtures, examples and native Cargo crates are not separate release components;
crate versions and native protocol identities remain independent. The initial
manifest baseline `0.0.0` and initial version `0.1.0` bootstrap the first
release; the baseline is not a claim of an existing tag. The 0.x releases are
experimental and do not establish production qualification.
Review the generated version PR and its changelog before its first merge.
Release Please opens each new version PR as a draft. The release workflow then
synchronizes the Bun workspace lockfile before Code Foundry manages readiness;
with a validated automation token it can mark the updated PR ready for review.
The PR draft setting is separate from GitHub release visibility. Existing ready
PR updates still receive synchronize validation. Verify the lockfile sync and all
required checks on the generated PR. npm publishing and post-release
publication remain disabled. CodeQL and
Dependency Review are enabled for this public repository. Automatic CI remains
controlled by the existing repository variable and checked-in billing policy.

## Verification

The post-M3 audit runs two real sync passes and compares final file-content hashes,
including custom workflow and hook output. The duplicate-layout, pin-integrity,
manual-dispatch and hook tests run in `bun run check`. The review record is in
[the foundation audit](foundation-audit.md). Historical milestone evidence is
retained separately and is not rewritten by synchronization.

## Formatting after synchronization

The wrapper applies the pinned Bun formatter configuration to Foundry-managed output
after the repository overlay. Sync does not reformat application source or
historical evidence. `bun run format:check` verifies the complete maintained
source tree and runs as the first step of `bun run check`. See
[formatting](formatting.md) for separate Python/Rust commands.

## Complete local validation

`bun run check:ci` executes the installed Foundry audit (not just its plan or
Doctor), browser-only checking, AST boundaries, native/reference checker
qualification, and `actionlint`. Install the contributor requirements into
`.venv` first and keep that environment on PATH; set `PYTHON` to the same
interpreter. `requirements.txt` includes the existing observer, formatter, and
frontend manifests plus pinned pytest, which upstream Foundry invokes for the
unchanged unittest-based suite. `pytest.ini` limits discovery to owned tests,
uses strict configuration, and disables unrelated third-party plugin autoload.

The five baseline capabilities are explicitly required so removing a command
cannot silently turn a required check into a skip. Optional performance,
release, and unimplemented integration lanes are not fabricated. Foundry does
not own the two nested Cargo workspaces: `bun run check:ci:native` and their
native workflows validate them with the declared 1.85.1/1.91.0 toolchains.
Neither local audit command modifies CI billing, branch rules, or publishing.
