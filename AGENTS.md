# Bun Native — autonomous implementation instructions

**Active direction (October 31, 2026):** Bun Native is a **complete, unconditional rewrite** of the old Bunly experimental CEF/WebView desktop framework. The old runtime, DOM/CEF APIs and tests are obsolete and should be deleted/replaced under [BN0 #251](https://github.com/0xPlayerOne/bun-native/issues/251), not retained as fallbacks. Historical source remains in Git history. Build native desktop apps authored in TypeScript/JavaScript with Bun, native UI rendering (Rust GPUI is the initial engine), and **Bun AOT production compilation**. SolidJS comes first, React second. No WebView or CEF fallback.

**Owner's authorization:** This public repository is a fully experimental project. An assigned agent may autonomously perform every implementation and cleanup task in [roadmap #1](https://github.com/0xPlayerOne/bun-native/issues/1), including source deletion, refactors, dependencies/toolchain changes, issues, branches, draft/ready PRs, CI, repo release tooling, and auto-merge when GitHub rules permit. **Do not ask for routine approvals, design sign-offs, milestone checkpoints, or manual testing.** Make practical decisions and document major architecture changes. Continue onto other unblocked tasks while CI runs or blockers are repaired.

## Start and operating sequence

1. Read this file, the [roadmap](https://github.com/0xPlayerOne/bun-native/issues/1) and relevant GitHub issue, and inspect the actual branch/worktree and managed contribution policy below. Do not treat the old `docs/architecture.md`, README or legacy Bun 1.4.4 configuration as Bun Native requirements when they describe CEF.
2. Start [#251](https://github.com/0xPlayerOne/bun-native/issues/251) (remove/replace CEF codebase) and [#225](https://github.com/0xPlayerOne/bun-native/issues/225) (pin current Bun AOT/GPUI toolchain) without waiting on a prototype or human choice. Then native window #230, AOT binary #227, integration blockers #226, and follow dependencies across BN1–BN7.
3. Open a draft PR with the first useful commit, push incremental work, run focused validation, mark ready when prepared and enable auto-merge if repository checks allow. Never bypass protected branch checks, fabricate a passing test, or force a merge. Keep other ready tasks moving.
4. If an integration test fails, reproduce it, log exact tools/OS/build mode, fix or choose another valid native implementation, and continue. No project stop/go gate. Bun's normal JIT may be used in development; **do not** label a JIT release as AOT. Keep browserless native UI and Bun AOT as the production objective.
5. Use strict TypeScript for authored core code when appropriate; JavaScript is a first-class supported consumer language. Build Rust native internals once/prebuild artifacts; ordinary consumer TS/JS edits must not silently compile native sources.

## Autonomous validation strategy

- **Default: GitHub Actions hosted runners.** Use Linux, Windows and macOS matrices for build, test, actual GPUI/native-window interaction when available, packaging and benchmark evidence. Preserve exact Bun, compiler, native host and OS versions; distinguish real window tests from mocks and compile-only tests.
- **Secondary: Remote Desktop Commander on the owner's connected Mac.** Discover the currently online device at runtime. Use it for native GUI, keyboard, text/IME and OS-specific validation where hosted CI is insufficient. Keep test files in a bounded temporary project directory and never alter the user's personal data, security settings, credentials or unrelated processes. No human test operator is required.
- **Containers:** Prefer hosted CI. Use Docker on the Mac only for a scoped necessity, with disk budget and cleanup; avoid large persistent images, volumes and caches.
- If an exact physical/GPU/accessibility check is unavailable, document the unsupported coverage and file a follow-up; work on the next unblocked issue. Unsupported is **not** passed, but it is not a reason to hold up unrelated development.

## Safety and scope

The agent has broad discretion **inside `0xPlayerOne/bun-native`**. This does not grant authority to mutate Adea production, unrelated repositories, personal Mac files or external accounts. Use only already configured tool credentials and service flows. Protected branches, sign-in and actual external platform permissions still apply. Preserve required upstream copyright/provenance when reusing code. Do not publish secrets. Experimental unsigned artifacts may be distributed within project workflows; production signing/notarization is only claimed when actually verified.

The Code Foundry-managed requirements below remain applicable. Interpret them alongside this explicit owner authorization to avoid unnecessary human checkpoints; they do not require retaining CEF code.

<!-- code-foundry-managed: config-aware-policy -->

These instructions are the repository-level operating contract for coding agents, including Hermes, OpenCode, and other automation.

They complement `.github/CONTRIBUTING.md`. More specific instructions in nested `AGENTS.md` files and project documentation take precedence for their directory.

<!-- /code-foundry-managed: config-aware-policy -->

<!-- code-foundry-managed: mission -->

## Mission

- Keep formatting, linting, type checking, builds, tests, and coverage reproducible locally and in CI.
- Prefer the repository's configured toolchain; `toolchain: auto` uses native
  tools unless an existing `.mise.toml` is present.
- Do not commit secrets, generated credentials, local environment files, or machine-specific paths.
- Add tests for behavior changes and keep coverage thresholds explicit in the project configuration.
- Make the smallest complete, well-tested change that solves the requested problem without disturbing unrelated work.

This repository may contain TypeScript, Rust, Python, or any combination of them. Detect the active stack from the files present; do not assume every check applies.

<!-- /code-foundry-managed: mission -->

<!-- code-foundry-managed: contributing-back -->

## Contributing back

Consumers are encouraged to help improve this open-source project. Open a small,
focused pull request for bug fixes, performance improvements, documentation, or
other narrowly scoped changes. For larger feature requests or architectural
changes, create an issue first so the proposal can be discussed and scoped.
Contributions should help make the tool as performant, reliable, and helpful as
possible for everyone.

<!-- /code-foundry-managed: contributing-back -->

<!-- code-foundry-managed: read-before-acting -->

## Read before acting

Before editing:

1. Read this file and `.github/CONTRIBUTING.md`.
2. Find and read any nested `AGENTS.md` that covers the files you will touch.
3. Read the nearest README, package manifest, build configuration, and relevant tests.
4. Inspect the current branch, worktree, remotes, and recent history:

   ```sh
   git status --short --branch
   git remote -v
   git log -5 --oneline
   ```

5. Identify the repository's package manager, lockfile, runtime versions, test commands, deployment assumptions, and generated files.

If the worktree is dirty, preserve existing changes and avoid overlapping edits until their ownership is clear.

<!-- /code-foundry-managed: read-before-acting -->

<!-- code-foundry-managed: priorities -->

## Priorities

When instructions conflict, use this order:

1. System and user instructions
2. This repository's instructions and explicit task scope
3. Nested directory instructions
4. Existing project conventions
5. General best practices

Ask for clarification when a missing decision would materially change the implementation. Otherwise make the smallest reasonable assumption and document it.

<!-- /code-foundry-managed: priorities -->

<!-- code-foundry-managed: safety-boundaries -->

## Safety boundaries

- Do not discard, reset, overwrite, or rewrite user-owned changes.
- Do not expose or commit secrets, credentials, tokens, private keys, local environment files, or personal machine paths.
- Do not modify production resources, repository settings, branch protections, secrets, deployments, or external systems unless explicitly requested.
- Do not add organization- or product-specific details to this reusable baseline.
- Do not change dependency managers or lockfiles unnecessarily.
- Do not bypass hooks, tests, review requirements, or required checks to hide a failure.
- Do not claim completion while required validation, review, deployment, or user decisions remain pending.
- Publishing, committing, or opening a pull request requires explicit task scope or user authorization.

<!-- /code-foundry-managed: safety-boundaries -->

<!-- code-foundry-managed: standard-workflow -->

## Standard workflow

1. Restate the desired outcome and identify the files or systems in scope.
2. Inspect before editing; preserve unrelated work.
3. Plan the smallest coherent change.
4. Implement with existing project patterns.
5. Run `npx code-foundry init` for a new checkout, or `npx code-foundry doctor` to diagnose setup drift.
6. Run focused checks while iterating.
7. Inspect the final diff for accidental changes, secrets, formatting, and generated files.
8. Run the broadest applicable validation available.
9. Report what changed, exact checks and results, skipped checks with reasons, risks, and remaining work.

For normal feature work, branch from `main` and target pull requests at `main`. Treat `main` as the protected release branch. Follow `.github/CONTRIBUTING.md` for the complete internal and external contribution flow.

<!-- /code-foundry-managed: standard-workflow -->

<!-- code-foundry-managed: git-workflow-and-merging -->

## Git workflow and merging

This repository uses the `direct` workflow: topic branches **squash** directly into `main`, and the Release Please version PR **squashes** into `main` (`release_merge_strategy: squash`). Feature and release PRs land on `main` with squash merges. No integration branch exists; all pull requests target `main`.

Merge only with the repository's canonical method. Never merge with `--admin`, never default or auto-select a merge method, and never use a method the branch ruleset does not allow. When in doubt, prefer the merge button's configured method and verify the ruleset after merging. Check `.github/CONTRIBUTING.md` for the complete flow and merge table.

### Branch and commit policy

Branch rulesets enforce deletions, force-pushes, required status checks, pull
requests, conversation resolution, and linear history where the repository's
plan supports them. Mirror those rules even where the plan cannot enforce
them:

- Branch from the default branch using
  `feat/*`, `fix/*`, `chore/*`, `refactor/*`, `docs/*`, or `test/*` names.
- Never push directly to protected branches; open a pull request.
- Use Conventional Commit subjects (`feat:`, `fix:`, `chore:`, …); Release
  Please depends on them to version releases.
- Keep pull requests focused; merge with the canonical method only after
  required checks pass.

<!-- /code-foundry-managed: git-workflow-and-merging -->

<!-- code-foundry-managed: pull-request-policy -->

## Code Foundry workflow policy (mandatory)

This repository uses the `direct` workflow. Topic pull requests target `main`.

- Open every ordinary pull request as a draft. Use `gh pr create --draft` or
  set `draft: true` in the GitHub API; never create a ready ordinary pull
  request as a shortcut.
- Keep ordinary pull requests in draft while preparing them. The generated
  Draft Guard converts ready ordinary pull requests to draft when they are
  opened or reopened, and runner-heavy validation starts only after an
  explicit `ready_for_review` transition unless `draft_protection: false` is
  configured for generated callers. That opt-out does not disable Draft Guard
  or draft-PR automation. Cloudflare reusable callers use
  `draft-protection: false`.
- Run local validation and finish review preparation before marking an ordinary
  pull request ready. Ready pull requests stay ready when new commits arrive,
  and validation reruns for the current head; draft updates allocate no
  validation runner until the pull request is ready.
- This contract is mandatory for every agent scope. Nested `AGENTS.md` files
  may add stricter rules but must not weaken or replace it.
- Release Please version pull requests are managed by the Code Foundry release
  workflow; do not manually change their draft state unless the workflow asks.

<!-- /code-foundry-managed: pull-request-policy -->

<!-- code-foundry-managed: toolchain-and-dependencies -->

## Toolchain and dependencies

- Follow `toolchain: auto` in `.github/code-foundry.yml`; use native tools by
  default and reuse mise only when the repository already has `.mise.toml`.
- If `toolchain: mise` is selected, run `mise install` before validation.
- Use the package manager indicated by the existing lockfile:
  - `bun.lock` or `bun.lockb` → Bun
  - `pnpm-lock.yaml` → pnpm
  - `yarn.lock` → Yarn
  - `package-lock.json` → npm
- Use the existing Python environment and dependency manifest. Prefer a project-managed virtual environment.
- Use Cargo commands and the committed Cargo lockfile for Rust projects.
- Do not mix package managers or regenerate lockfiles as a side effect.
- Keep dependency additions narrowly scoped and explain security, licensing, and runtime impact.

<!-- /code-foundry-managed: toolchain-and-dependencies -->

<!-- code-foundry-managed: validation -->

## Validation

From a consumer repository, use its documented package scripts or the installed
Code Foundry CLI:

```sh
npx code-foundry plan --tier fast
npx code-foundry check --tier fast
npx code-foundry check --tier audit
```

`plan` discovers tasks without running them. `check` invokes the shared runtime;
`fast` includes CI tasks, unit tests and performance, while `audit` adds
integration, E2E and smoke.

From a Code Foundry source checkout only, the shared runtime is also available.
The paths below are relative to that checkout, not a consumer repository. The
runtime detects supported tools and skips inapplicable checks:

```sh
node src/runtime.mjs ci format
node src/runtime.mjs ci lint
node src/runtime.mjs ci type_check
node src/runtime.mjs ci build
node src/runtime.mjs ci unit
node src/runtime.mjs ci integration
node src/runtime.mjs ci e2e
node src/runtime.mjs ci smoke
node src/runtime.mjs ci eval
node src/runtime.mjs ci performance
```

Security and dependency audits run through the GitHub Security workflow.

Run focused tests first, then the complete applicable set for release, security, workflow, dependency, and configuration changes.

At minimum:

- TypeScript/JavaScript: Oxfmt formatting, Oxlint linting, type-check, build, and Bun's native test runner for unit/integration tests; use the project's native browser runner for E2E tests. Repositories using a different linter or formatter keep full control through their own `lint`/`format` scripts, which the runtime honors.
- Do not add Vitest. Preserve specialized native runners such as Matchstick for The Graph and Hardhat for smart contracts.
- Rust: default rustfmt, Clippy with warnings treated as errors, check, unit/integration tests, and dependency audit
- Python: Ruff formatting and linting, compile or type checks, pytest, coverage, and dependency audit
- Mixed projects: validate each active ecosystem and its integration boundaries

If a check cannot run, state the exact reason. A skipped check is not a passing check.

The generated `.githooks/pre-commit` gate is change-aware so parallel work on a
shared checkout is not serialized behind repository-wide checks. It blocks
whitespace errors, formats and lints only staged files, runs the project's
type-check command only when typed sources or compiler configuration are
staged, and does not build unless `pre_commit_build: true` is set. Passing the
hook is not full validation: run the broader checks above before opening or
readying a pull request.

<!-- /code-foundry-managed: validation -->

<!-- code-foundry-managed: tests-and-coverage -->

## Tests and coverage

- Add or update tests for behavior changes and regressions.
- Keep unit, performance, integration, E2E, and smoke coverage in the suite where each applies.
- Preserve project-specific coverage thresholds; do not lower them to make CI green.
- Keep test data deterministic and remove secrets from logs and fixtures.
- Use the narrowest test command while iterating, then run the affected package or workspace suite.

<!-- /code-foundry-managed: tests-and-coverage -->

<!-- code-foundry-managed: github-workflows-and-configuration -->

## GitHub workflows and configuration

- Keep workflows concise, independently runnable, and safe to re-run.
- Use `push` for `main` and `pull_request` for `main` unless a workflow has a documented event-specific reason.
- Give workflows clear names and jobs concise names; avoid repeating the workflow name in the job name.
- Use per-workflow concurrency groups keyed by pull request or ref that cancel superseded pull-request runs while allowing independent workflows to run in parallel. Do not cancel in progress for pushes to `main`, release, publication, or deployment runs; let them queue.
- Do not put `always()` on heavy jobs: it keeps a cancelled run alive and holding its concurrency group. Use `!cancelled()` for jobs that must run after upstream failures, and keep `always()` for lightweight aggregate gates only.
- Keep setup language-aware and cache dependency downloads by lockfile; do not cache secrets, `node_modules`, virtual environments, or broad build output without a measured reason.
- Use least-privilege permissions and pin action versions consistently with the template.
- Keep CI, Test, Security, CodeQL, Draft Guard, Draft PR, Release PR, and Release concerns separated.
- Security and CodeQL may skip when repository visibility or GitHub plan support does not permit them. Do not make an unavailable check required.
- Optional Turborepo Remote Caching uses `TURBO_TOKEN` and `TURBO_TEAM`; do not add Vercel deployment behavior just to enable caching.
- Update branch protection when adding or renaming required job checks; verify the actual GitHub status context.

<!-- /code-foundry-managed: github-workflows-and-configuration -->

<!-- code-foundry-managed: documentation-and-generated-files -->

## Documentation and generated files

- Update documentation when behavior, setup, configuration, commands, or operational procedures change.
- Keep `.env.example` limited to variable names and safe placeholders.
- Do not commit build output, caches, coverage output, dependency directories, generated credentials, or temporary files.
- Preserve formatting and line-ending conventions from `.editorconfig` and `.gitattributes`.

<!-- /code-foundry-managed: documentation-and-generated-files -->

<!-- code-foundry-managed: completion-report -->

## Completion report

End every agent task with:

```text
Summary:
Files changed:
Validation:
Skipped checks:
Risks or follow-up:
Branch/PR:
```

Use exact command names and outcomes. Mention external changes separately from local changes, and distinguish completed work from recommendations.

<!-- /code-foundry-managed: completion-report -->
