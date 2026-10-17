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
- Dependabot covers the two independent native manifest roots, the root Bun
  workspace, and the three independently locked benchmark dependency projects.
- Every existing qualification job reads the same `CI_BILLING_PAUSED` variable
  as the generated workflows. Job steps and assertions are preserved.
- The generated pre-commit hook runs the installed CLI through Bun, while
  retaining upstream machine-hook chaining. A global Node installation is not
  required for these repository scripts.

The generated baseline is reapplied before each overlay. Repeated repository
syncs produce identical final file contents. The wrapper fails on unexpected
upstream layouts instead of guessing how to rewrite them.

## Billing pause

`.github/code-foundry.yml` currently sets `billing_paused: true`. Dependabot
version-update PR limits are zero and its required schedule is monthly.

The Actions repository variable is a separate GitHub setting:

```sh
gh variable set CI_BILLING_PAUSED --repo 0xPlayerOne/bunly --body true
```

This command was **not executed** through the available connection: its tools
expose no Actions-variable write operation and no authenticated terminal was
available. A checked-in YAML value does not create the repository variable.
Do not report the remote setting as paused until its value has been read back.

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
hook path before relying on it. Do not bypass a failing hook as a workaround.

## Local validation

The installed archive was obtained from Code Foundry's completed release
qualification, not by starting a new Actions run. Its SHA-256 matches the
published v1.48.2 release asset:
`adac8eb62ca6d39d75967a416a66a5a42768be32fc653f26612bfd43da60adc9`.
The committed lockfile retains the registry version and published SHA-512
integrity, with no local archive path or temporary registry URL.

A frozen, offline Bun 1.4.3 install, repeated-sync hash comparison, browser-only
typecheck, lint, boundary check, compiler-free build, and 12 new configuration
regressions pass locally. The baseline test snapshot used for local checks
contains 68 existing portable tests; these results do not requalify the later
native/platform changes on main. Code Foundry doctor reports only the missing
Cargo executable and consequent nested-manifest metadata checks in this Linux
container. CI execution remains unavailable while the account has no minutes.
