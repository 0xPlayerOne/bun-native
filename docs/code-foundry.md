# Code Foundry

Repository tooling, separate from the Bunly desktop runtime.

**Package:** `code-foundry@1.48.2`, an exact development dependency.
**Runtime:** `0xPlayerOne/code-foundry@v1.48.2`.
**Source:** `0b5374bc59599b53e298bcf461d7727a9938b3ae`.
**Profile:** Bun monorepo with TypeScript, Rust, and Python contributor code.

## Commands

```sh
bun install --frozen-lockfile
bun run foundry:init
bun run foundry:sync
bun run foundry:doctor
bun run foundry:plan
```

Use the repository scripts rather than bare `code-foundry sync`. The wrapper
calls the unmodified installed CLI from the repository root, then applies these
Bunly-specific adjustments:

- GitHub files remain under `.github/`, with a single case-safe
  `PULL_REQUEST_TEMPLATE.md` and no `.guthub` or nested `.github/.github`.
  Preflight rejects misplaced directories, nested case collisions and linked
  output paths before the upstream initializer writes files.
- Dependabot covers the two independent native manifest roots, the root Bun
  workspace, and the three independently locked benchmark dependency projects.
- Every qualification job and generated caller reads `CI_BILLING_PAUSED`.
  Newly added custom workflows are included automatically. Unknown authored
  conditions fail for review instead of silently losing their predicates.
  Job steps, permissions, triggers and existing predicates are preserved.
- The generated pre-commit hook runs the installed CLI through Bun, while
  retaining upstream machine-hook chaining. A global Node installation is not
  required for these repository scripts.

The generated baseline is reapplied before each overlay. Repeated repository
syncs produce identical final file contents. The wrapper fails on unexpected
upstream layouts instead of guessing how to rewrite them.

## Billing pause

`.github/code-foundry.yml` currently sets `billing_paused: true`. Dependabot
version-update PR limits are zero and its required schedule is monthly.

The sync overlay also makes Actions **paused by default** when that checked-in
setting is true. Each job requires `vars.CI_BILLING_PAUSED == 'false'` before its
original conditions can permit execution. An unset variable therefore cannot
accidentally enable jobs while the account has no minutes. This applies to
ordinary jobs and reusable-workflow callers, before runner allocation.

| Checked-in `billing_paused` | Repository variable | Job behavior |
| --- | --- | --- |
| `true` | Unset or `true` | Skipped |
| `true` | `false` | Original conditions apply; explicit remote override |
| `false` | Unset or `false` | Original conditions apply |
| `false` | `true` | Skipped |

An unexpected value is not an opt-in while paused. Sync retains multiline
conditions and rejects a leading guard bypassed by a top-level OR. The pause
is scheduling policy, not successful test evidence or a substitute for review.
Already queued runs and workflows on branches without these guards are not
cancelled or modified by this change. The fallback takes effect on branches
containing the synced files; it is not yet on `main` until this PR is merged.

The Actions repository variable is a separate GitHub setting:

```sh
gh variable set CI_BILLING_PAUSED --repo 0xPlayerOne/bunly --body true
gh variable get CI_BILLING_PAUSED --repo 0xPlayerOne/bunly
```

These remote commands were **not executed** through the available connection:
its tools expose no Actions-variable write operation and the authorized desktop
is offline. The checked-in fallback does not create a repository variable.
Do not report the remote setting as changed until it has been read back.

To resume intentionally, set the repository variable to `false`, set
`billing_paused: false` in the configuration, and run `bun run foundry:sync`.
This does not add paid minutes or change GitHub billing limits. No branch rules,
required checks, repository permissions, or publishing settings are changed.
The upstream `code-foundry ci pause` command also modifies managed branch-rule
checks and cancels runs; it is deliberately not used as a variable-only setter.

## Preserved policies and limitations

The existing MIT `LICENSE` is unchanged. Code Foundry's own license and template
notices remain applicable to its material; see `NOTICE`. Existing Bunly agent
instructions precede the managed Code Foundry policy blocks. Authored documents,
the original issue templates, and the eight native/benchmark workflows remain.

`features` selects validation, draft-PR tooling, and paused dependency updates.
Automatic releases and npm publishing are not enabled. Private-repository
CodeQL and Dependency Review are explicitly off; no paid security service is
enabled. Billing-lane consolidation is left off during initial qualification.

The existing TypeScript compiler and Oxlint versions/rules are retained. The
baseline formatter configuration is installed, but no new formatter binary or
whole-repository formatting migration is introduced by this change. The fast
plan reports unavailable format/native tasks rather than pretending they ran.
Native compilation, CEF execution, signing, and platform-specific qualification
remain separate contributor work. The generic Code Foundry Rust hook currently
assumes a root Cargo manifest; native edits must qualify that nested-workspace
hook path before relying on it. Formatter/Python tools also need contributor
installation before the corresponding hook checks can run. Do not bypass a
failing hook as a workaround.

## Local validation

The installed archive came from Code Foundry's completed release qualification,
not a new Actions run. The supplied artifact and pack metadata were checked:
`adac8eb62ca6d39d75967a416a66a5a42768be32fc653f26612bfd43da60adc9`
(SHA-256). The committed lock retains the registry version and published SHA-512
integrity, with no local archive path or temporary registry URL.

For the resumed setup, all 27 existing `.github` file hashes were verified
against PR #65 before applying the new pause overlay. The 24 configuration,
layout and billing tests pass with actual Bun 1.4.3, as do strict TypeScript,
Oxlint, browser boundary checks, browser-only typechecking and compiler-free
SDK builds. Two additional real sync runs preserve identical hashes across
186 source/configuration files in the local validation fixture.

That fixture uses the retained offline snapshot: its 68 older portable tests
plus 24 Foundry tests pass, but it is not the complete current-main suite.
Unrelated newer runtime work is preserved in the remote base tree, not claimed
retested. The package was rehydrated from the verified qualified archive;
a fresh frozen offline install in this reset container still lacks its registry
cache metadata. The prior installation's frozen-install result is recorded in
PR #65, not newly claimed here. Code Foundry doctor reports missing Cargo and
three consequent native manifest metadata errors. Native/platform tests and
GitHub Actions were not run, retried or dispatched for this continuation.
