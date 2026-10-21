# Manual native qualification

Disposable Windows, Linux and macOS test jobs, independent of automatic CI.

**Scope:** Developer qualification; no production release, credentials or self-hosted runner.
**Workflow:** `.github/workflows/cef-runtime.yml` — M3 native CEF runtime.

## Run a test

In GitHub, open **Actions → M3 native CEF runtime → Run workflow**. Select the
reviewed branch, a platform, and a suite. The default is Windows/full.

```sh
gh workflow run cef-runtime.yml --ref main -f platform=windows -f suite=full
gh workflow run cef-runtime.yml --ref main -f platform=linux -f suite=smoke
gh workflow run cef-runtime.yml --ref main -f platform=macos -f suite=full
gh workflow run cef-runtime.yml --ref main -f platform=all -f suite=portable
```

| Selection | Hosted environment                                                  |
| --------- | ------------------------------------------------------------------- |
| `windows` | `windows-2022`, x64                                                 |
| `linux`   | `ubuntu-22.04`, x64, X11/Xvfb and D-Bus                             |
| `macos`   | `macos-15`, arm64                                                   |
| `all`     | All three independently; one failure does not cancel the other jobs |

`portable` runs the frozen installation, TypeScript checks/build/tests, browser
boundaries, and Python tests. `smoke` additionally builds the pinned native
runtime and executes the complete prebuilt startup/rejection/lifecycle matrix.
`full` also runs development-origin isolation and the four native fault cases,
with explicit browser identity and OS isolation evidence. Windows/Linux full
results must satisfy the existing platform-evidence validator.

Each platform has a 60-minute job ceiling and the native execution step has a
20-minute ceiling. There are no automatic retries or slower deadline fallbacks.
These are standard GitHub-hosted jobs, not persistent cloud machines. No local
Docker container, VM console, Apple developer account or cloud credential is needed.
The host builder compiles Rust; the consumer acceptance phase runs the assembled
application with its separate compiler-free checks.

## Manual execution and the billing pause

`CI_BILLING_PAUSED` still controls automatic PR jobs. A maintainer's explicit
`workflow_dispatch` can run the two manual-only jobs without changing that variable.
Foundry's overlay preserves only the exact manual-event predicate, and requires
a declared dispatch trigger. An OR expression cannot bypass its ordinary pause
guard. Automatic jobs never run as a side effect of manual dispatch, and draft
PRs do not start the automatic native matrix.

Workflow permissions remain `contents: read`; checkout credentials are not
persisted. No secrets, public release uploads, package publication, remote
interactive access, self-hosted runner, sandbox-disabling flag, or trusted
certificate is involved. Action versions and the Bun/Rust/CEF inputs are pinned.
Only successful native runs save the dependency/browser download cache; this
manual cache is separate from the existing automatic lane.

## Windows privilege boundary

The hosted build account is an administrator. The qualification launcher creates
an ephemeral **standard local user**, grants access only to the job checkout and
private `.bunly` output, and launches the native tests under that account. The
worker independently rejects administrator execution. The random local password
is masked and held in memory, never included in command-line arguments or saved
artifacts. The user is removed in the launcher's `finally` block; cancellation
also disposes of the entire hosted VM. This launcher refuses to operate outside
a GitHub-hosted Windows job.

Native helper restricted-token/job observations are separate from the build
account's privileges. A missing desktop, unsupported sandbox, failed cleanup,
or absent report fails the job rather than becoming an unsupported zero-time pass.
No physical input/DPI, hardware acceleration, production signing or performance
advantage is inferred from an unattended hosted run.

## Results and failed runs

Open the run's job summary and download `native-<target>-<suite>-<run>-<attempt>`.
Artifacts retain seven days of explicit logs and JSON observations, including
failures; they exclude whole `.bunly` trees, VM disks, source credentials and
compiled distributions. Private fixture nonces are redacted. Cancellation may
prevent the final artifact upload; a cancelled run never counts as acceptance.

A workflow completing portable checks is not proof that native CEF execution
passed. `qualification.json` records its suite, source identity, actual target,
per-scenario exits and acceptance outcome. Preserve evidence and verify the
required native results before closing a platform issue.
