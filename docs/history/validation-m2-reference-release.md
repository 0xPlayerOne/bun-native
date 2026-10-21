# M2 reference and release-runner validation

**Record type:** Historical checkpoint. Current status and commands are in [the documentation index](../README.md).

**Base:** `e8722cd305d97904d01d22504e20287212636df9` (merged #71).
**Scope:** Executable reference adapters and stage tooling for #8/#9/#10.
**Status:** Source implementation checked locally; M2 remains open.

## New behavior

- Mirin and Butter adapters call the real upstream CLI and compiled executable,
  require the full shared workbench, preserve unsupported capabilities, and verify
  explicit dependency versions/lock hashes. No fake runtime fills a missing package.
- Reference release presets execute cold dependency installation, upstream assembly,
  and portable archive compression through independent output verifiers.
- The general stage runner has a complete disposition matrix, dependent-stage
  blocking, fresh output/receipt validation, and separate byte categories.
- The CEF inspector reads exact exported binary versions in an isolated observed
  process; the Electrobun qualifier now uses it rather than a reduced user agent.
- Early cancellation now uses buffered control input instead of an immediate signal
  that could kill the observer before it installed handlers and wrote cleanup data.

## Local checks

Environment: Linux x64, Bun `1.4.3+c6da4a4d3`, retained hash-verified dependency
snapshot, Python 3.11 and psutil 7.2.2. No fresh dependency install is claimed.

| Command                                    | Result                                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `bun run check`                            | 184 tests passed; TypeScript, Oxlint, browser AST boundaries and compiler-free builds passed.                                 |
| `bun run typecheck:browser`                | Passed.                                                                                                                       |
| `python tests/cef_identity_test.py`        | Eight passed; loader contracts and hash/error cases.                                                                          |
| `python tests/reference_archive_test.py`   | Eight passed; real archive contents, links, stale outputs and changes.                                                        |
| `python tests/process_observer_test.py`    | Six existing process-observer cases passed.                                                                                   |
| `bun scripts/qualify-cef-inspector.ts`     | Three actual native ABI fixture cases passed: version calls, wrong-hash rejection and isolated abort. The fixture is not CEF. |
| `bun scripts/qualify-observed-commands.ts` | Seven actual process cases passed, including cancellation, timeout, overflow and orphan cleanup.                              |
| `bun scripts/qualify-development.ts`       | Twenty bare-Bun executions passed: one warmup plus three trials of five scenarios. Not desktop HMR.                           |
| Python compile checks                      | Observer, native inspector and archive utility passed.                                                                        |

The new TypeScript tests include three deliberate early-abort timings (0/5/100 ms)
with a real Python interpreter whose observer entry is delayed by 750 ms. They
verify that cancellation sent before initialization is received and cleanup is
recorded. An earlier broader run exposed this race; that failure was fixed rather
than suppressed by extending the delay. A real stage integration test builds a
small explicit payload, runs the compressor, verifies every archive member in a
separate process, and records distinct installed/compressed sizes.

The total is **147 retained snapshot cases plus 37 new cases**. It is not the full
current-main RPC/native/artifact/Foundry test suite. Touched existing modules were
checked against the merged source blobs; all other main files are preserved by
constructing the commit from the current base tree, not copying the older snapshot.

## Executed failure and unavailable paths

The sandbox-enabled frontend driver was retried as non-root with installed Chromium
144.0.7559.96 and Playwright 1.57.0. Initial local navigation again produced
`ERR_BLOCKED_BY_ADMINISTRATOR`. Its failed warmup and unexecuted remaining trials
remain explicit. No managed policy, sandbox, or engine substitution was used to
bypass this restriction.

Electron/Mirin/Butter exact installed dependencies and reviewed reference locks are
not available in this network-disabled executor. No actual Mirin/Butter desktop,
upstream release, CEF-version or process-sandbox qualification is claimed. The
available connected macOS machines were offline. Windows/macOS runtime reruns,
controlled hardware benchmarks, platform signing, actual installer integration,
update transactions, and full network-byte instrumentation were not performed.

Ruff and Oxfmt were unavailable. No root dependency/lockfile, Code Foundry config,
`.github` workflow, CI billing pause, repository visibility, publishing or Adea
changes are included. No Actions runs were dispatched or retried.

## Remaining closure requirements

- **#8:** successful frontend and desktop edit/workbench execution on a supported,
  policy-permitted qualification machine. Protocol/unit fixtures are not that result.
- **#9:** actual adapter stage measurements, signing/first-run/update verification,
  full download accounting and controlled calibration. The portable archive profile
  is not equivalent to upstream native installers. Generic stage support is not
  evidence that every preset stage has run.
- **#10:** actual broader Electrobun/Mirin/Butter runs, exact installed source/browser
  identities and OS-process sandbox qualification with equivalent configurations.

No issue closes merely because the new machinery passes its own tests.
