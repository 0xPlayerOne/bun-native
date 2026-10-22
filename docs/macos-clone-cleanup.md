# macOS post-exit clone cleanup

Identity-bound observation of Chromium's security-clone cleanup after native host exit.

**Scope:** Contributor qualification and resource accounting for issue #88.
**Runtime:** Existing Chromium cloning, sandboxing, host shutdown and ordinary descendant deadlines remain enabled.
**Native evidence:** Run the maintained baseline/current qualifier below; policy unit tests alone do not satisfy native acceptance.

## Why cleanup can outlive the host

The pinned Chromium implementation launches its code-sign clone cleanup helper in a
new process group. It waits for its parent to exit using one-second polling before
removing the clone directory. The observer's ordinary 500 ms exit grace can therefore
expire during a legitimate upstream polling interval.

The primary implementation is
[Chromium 154.0.8037.98 code_sign_clone_manager.mm](https://github.com/chromium/chromium/blob/154.0.8037.98/chrome/browser/mac/code_sign_clone_manager.mm),
particularly `DeleteUniqueTempDirRecursivelyFromHelperProcess`,
`ChromeCodeSignCloneCleanupMain` and `HardLinkMainExecutable`. Chromium copies the app
using `clonefile` and then hard-links only the main executable back to its source.
That hard link provides an independent identity for the exact private fixture's clone.

This behavior belongs to qualification accounting. The change does not redefine when
the native host or its Bun backend must shut down. Ordinary descendants still fail
after 500 ms even if they exit during another helper's cleanup window.

## What authorizes the separate window

Before starting a recognized private Bunly fixture, the observer records the installed
main and helper executable identities and SHA-256 hashes. Hashing uses a 64 KiB buffer,
rejects links and files above 64 MiB, and verifies that the opened file and final path
still match. It binds the launched host to that prelaunch provenance.

An additional window of at most three seconds from observed root exit is available
only when all of the following are established:

- The helper was observed as a direct child of the same live root PID and creation
  time, or the kernel's retained original-parent unique ID matches the root identity
  captured while it was alive. Process names and command-line roles never establish
  ownership.
- The helper's actual executable path, user and retained file identity match the
  private installed helper. Its complete content is rehashed before extra time is
  granted.
- The argument list has exactly the pinned role and one valid six-character clone
  suffix. Additional or conflicting flags cannot qualify a process.
- The matching clone was independently observed under the private fixture namespace,
  with its main executable hard-linked to the launched host. Namespace and clone
  directory identities remain bound throughout observation.

The observer can discover at most 256 namespace entries and qualify at most eight
helpers. Namespace substitution, changed executable content, missing provenance and
reused PIDs fail closed. All signals revalidate a fresh PID/creation-time identity;
a stale stored `psutil.Process` object is never sufficient to target a process.

### Closing the last-sample race

A helper can launch after the last live descendant sample and be reparented before
the observer next runs. For a bound clone with no paired helper, the observer performs
one post-exit scan through libproc. `PROC_RUID_ONLY` restricts the inventory to the
current real user. A fixed 4,097-PID buffer includes one overflow sentinel; more than
4,096 returned entries rejects the scan before any PID is inspected. At most 4,096
kernel identities and eight confirming identity reads are made in this recovery
pass. Normal verification and sampling remain bounded by the existing time/sample
limits. No broad process-name or command-line inventory is retained.

`PROC_PIDUNIQIDENTIFIERINFO` supplies the process unique ID, original parent unique
ID, executable UUID and PID version in a fixed 56-byte reply. The original parent
ID survives reparenting. Recovery requires it to equal the still-live root's retained
unique ID, then rechecks PID/creation time, user, executable, the kernel identity and
the existing clone proof. Short, malformed, unsupported or unavailable replies confer
no ownership. A later kernel identity or executable-version change invalidates the
qualification. If this interface is unavailable, only independently observed live
ancestry remains usable; an unmatched clone cannot qualify.

The ABI and retained-parent behavior are documented in Apple's XNU
`xnu-12377.1.9`, commit `f6217f891ac0bb64f3d375211650a4c1ff8ca1ea`:
[proc_info_private.h](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/proc_info_private.h),
[proc_internal.h](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/proc_internal.h),
[proc_info.h](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/proc_info.h)
and [proc_info.c](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/proc_info.c).
This is a contributor-only macOS interface, not an application runtime dependency.

Each helper report identifies the proof used: `observed-root-child-and-matching-clone-inode`
or `retained-kernel-parent-and-matching-clone-inode`. The latter includes root, child
and original-parent unique IDs as bounded decimal strings to preserve all 64 bits in
JSON. The TypeScript validator rejects unknown proof kinds, lossy numeric IDs,
inconsistent parents, duplicate identities and inventory counts above the limit.

The parent namespace is specific to the pinned Bunly fixture's base bundle ID. The
observer does not scan other browsers' namespaces or remove any clone directory.
This is contributor provenance checking, with the repository's existing assumption
of a private user installation; it is not a defense against arbitrary hostile code
already running as the same user.

## Completion and resource accounting

Completion requires both disappearance of the same process identity and removal of
the exact bound clone directory. A substituted or vanished parent namespace cannot
prove cleanup. A process that exits while leaving its clone behind still fails.
Killing a stuck helper later does not turn its earlier failed observation into a pass.

Sampling continues through post-exit cleanup. The report records elapsed time, peak
sampled RSS and threads, descriptors in process rows, and CPU deltas between adjacent
samples with the same PID and creation time. CPU work between samples and after the
last live sample remains unmeasured; missing counters are reported as unavailable.
Post-exit samples use the `post-exit-cleanup` phase and count toward the fixed global
sample cap. Space for the bounded cleanup interval is reserved during ordinary
sampling.

Reports distinguish three outcomes:

| Status         | Meaning                                                                                 |
| -------------- | --------------------------------------------------------------------------------------- |
| `completed`    | At least one helper and clone were positively identified and completed within the bound |
| `not-observed` | No tracked failure, but the required helper/clone evidence was not collected            |
| `failed`       | Provenance, completion, deadline or clone-removal requirements failed                   |

`qualified` is true only for `completed`. A short startup rejection or a sampling gap
may legitimately have `not-observed`; it cannot establish native cleanup acceptance.

## Maintained native qualification

Use already prepared, locally signed baseline and current native apps:

```sh
python scripts/qualify-macos-clone-cleanup.py \
  --baseline /absolute/path/to/baseline.app \
  --current /absolute/path/to/current.app \
  --output .bunly/clone-cleanup-qualification.json
```

The runner creates private APFS clone copies, records executable and configuration
fingerprints, and executes the existing 20-cycle native smoke. Each app is tested
under prompt cleanup and deliberately delayed cleanup. The delayed case suspends
only an independently verified owned helper after the observer has reaped the root
with `wait()` and the helper has been reparented to PID 1. It holds that process for
at least 750 ms after the observed suspension, then revalidates identity before
resuming it. The report records both the held interval and time since observed root
exit. This is a controlled suspension, not a claim of 750 ms additional cleanup
latency: Chromium's existing sleep interval can elapse while the process is stopped.
A bounded `finally` path attempts to resume
the same owned process if observation is interrupted. No runtime timeout or Chromium
security feature is changed.

The initial injector stopped the helper before root exit. Its retained baseline
slow-case evidence showed a stopped helper disappearing at root exit while its clone
remained. Apple's pinned
[XNU `orphanpg` implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_proc.c)
and the [POSIX process-exit rule](https://pubs.opengroup.org/onlinepubs/009695299/functions/exit.html)
specify hangup and continue signals for a newly orphaned group containing a stopped
member. Because Chromium starts this helper in a separate process group, that rule
supports the inference that the pre-exit fault injection terminated the helper. The
observer cannot attest this helper's exit code; the signal cause is an inference,
not a captured exit status. The failed attempt and its private app copies remain
failure evidence. The corrected injector waits for completed root exit before it
sends any stop signal; a subsequent successful run does not erase the old failure.

Each of the four combinations must positively observe a clone and a helper, verify
removal and exit, and preserve normal native shutdown. The delayed case also requires
an observed stopped state and post-exit resource samples. Up to three attempts per
combination address missed sampling opportunities; every attempt is retained. An
actual failure stops the run and remains a failure. An unobserved attempt is never
relabeled as qualified. An existing output file is never overwritten.

Run the policy and observer regressions with:

```sh
python -m pytest tests/macos_clone_cleanup_test.py \
  tests/macos_process_identity_test.py tests/macos_clone_qualifier_test.py \
  tests/process_observer_test.py
bun test tests/observed-command.test.ts
```

These cover file and namespace substitution, PID reuse, foreign users/executables,
arbitrary flags, missing completion, bounded inventory, callback failure, and a real
role-only child that must still fail the ordinary orphan policy. On macOS an
unprivileged real-process test also verifies retained parent identity after reparenting.
Earlier issue #88
failure evidence remains unchanged. M4 renderer identity and authority acceptance
remains separate work.
