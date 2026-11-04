# First-window phase observation for #296

This is a **research branch, not a merge or native-acceptance candidate**. It
investigates the repeated first-window deadline failure, most recently required
job [126693200850](https://github.com/0xPlayerOne/bun-native/actions/runs/41863970025/job/126693200850)
on the documentation-only #353 merge. That required check remains failed.

## Predeclared experiment

Exactly **three independent fresh Ubuntu 24.04 runners**, trials 1, 2 and 3,
each run **one** original five-window lifecycle process. There is no warmup,
retry, extra observation selected after seeing results, or alternate backend.
The first open in each process is the observation of interest. A passed process
does not explain the historical failure or qualify #353.

The initial source is main c9ada928. The passive instance, adapter, device and
surface markers come from unmerged research
[#339, source 055c92bc](https://github.com/0xPlayerOne/bun-native/pull/339).
That experiment passed both its original and counterfactual cases on different
fresh runners; it did not establish a cause or production fix. This follow-up
retains **Vulkan|GL**, adding explicit colormap/X11-setup and surface-creation
boundaries. X11/renderer markers are limited to the first window while its GPU
context is empty, preserving the existing logger's 64-record budget.

Production dependency pins, locks, runtime source, fixture, logger bounds,
compiler flags, required workflows and gates are unchanged. The original
**5,000 ms request deadline** and **45-second lifecycle ceiling** remain. Native
unit tests run before the lifecycle; they do not open a GPU window or warm the
driver through an application.

Each runner uses its own Cargo home under its owned temporary experiment root.
Preparation verifies the pinned GPUI revision and original Git bytes before
writing any patch, rejects ambiguous/already-modified checkouts, and records:

- Exact repository and GPUI revisions, fixed trial plan and fixture/source hashes.
- Original and instrumented SHA-256 for every modified dependency file.
- Exact unified dependency patch and its SHA-256.
- Toolchain, CPU, native package and package-owned Lavapipe ICD identity.
- Actual release-host hash/size, raw lifecycle output and bounded startup trace.
- First-open phase pairs, same-logger-clock durations, unfinished nested phases,
  original process result, and identity-checked joined process cleanup.

The runner reuses the existing native driver's process ownership, output bounds
and cleanup. An exclusive attempt receipt prevents a second lifecycle process in
the same trial. Unknown/cross-run/malformed phase evidence fails closed.
An unfinished phase means its return was not observed; it does not by itself
prove deadlock, identify a driver defect, or make the preceding phase causal.
Recoverable device-request and surface-configuration errors emit an explicit
error exit before the original Result propagation, so trying the next adapter
does not leave a stale phase on the nesting stack.
Logging, supervisor polling and the changed build/cache environment can affect
timing. This is diagnostic evidence, not a performance comparison.

## Trigger and review

The standalone workflow has read-only repository permissions and a **push
trigger restricted to test/linux-startup-phases-20261104** and this experiment's
files. The narrow branch trigger follows #339's supported research path; the
existing manual required workflow would run the whole qualification suite and
cannot substitute this private-dependency diagnostic. The workflow has no
Validation / Gate job, honors the existing billing pause, and accepts only the
first workflow attempt. Fail-fast is disabled so every declared trial retains
its own result. Artifacts are uploaded after a failure for 14 days.

The coordinating agent owns publication and activation after local review.
Keep its PR draft, clearly labeled research, and archive the completed branch
without merging. Publishing the reviewed source activates the declared trials;
do not push again to chase a green outcome. If setup code is defective, retain
its failed evidence and declare the corrected experiment before activation.

Local preparation/check commands:

```sh
bun install --frozen-lockfile
ruff format --check experiments/startup-phases tests/quality/test_startup_phases.py
ruff check experiments/startup-phases tests/quality/test_startup_phases.py
python3 -m unittest discover -s tests/quality -p test_startup_phases.py -v
actionlint .github/workflows/startup-phases.yml
```

For an explicitly owned local disposable Cargo home, set GITHUB_WORKSPACE to the
checkout, STARTUP_PHASE_ROOT to a new temporary root, CARGO_HOME to that root's
cargo subdirectory, and STARTUP_PHASE_TRIAL to one declared trial ID. Fetch with
cargo fetch --locked, then run prepare.py. Never point preparation at a shared
Cargo checkout. The hosted workflow contains the exact build/session commands.

No local headless check establishes actual hosted GPUI behavior. A first-open
failure with complete internal markers can narrow the next investigation; if
all three pass, retain that result without calling the issue fixed.
