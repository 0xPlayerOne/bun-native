# CEF shutdown investigation

NetworkService shutdown state and native control results after the foundation merge.

**Status:** Unresolved intermittent failure; no verified native runtime fix or release qualification.
**Tracking:** [Issue #92](https://github.com/0xPlayerOne/bunly/issues/92).
**Evidence date:** October 23, 2026.
**Harness checkpoint:** Clean `dd95d8a261428c4bc029844332b61be1fbb142b1`.
**Native build checkpoint:** `a3e6ee0e8f1065889980c90e0d5111d878ff05a8`.
**Versions:** Bun 1.4.3; CEF 154.0.34; Chromium 154.0.8037.98; macOS arm64.

PR #89 was merged as `3869db31da2f53434104bbed76f3e18a9810e2a7`.
That merge does not convert its failed native qualification into a pass. The
native sources and foundation workload used here are unchanged through PR #91
head `1481e7c94d4d94768a6f8589525780d58d2e7542`. Browser build-profile scaffolding
is separate from resolving this failure and implementing native renderer authority.

The [sanitized evidence](../evidence/cef-shutdown-network-2026-10-23.json) retains
report lengths/hashes, exact harness fingerprints, outcomes and reviewed
aggregate findings. Raw dumps, process identities, addresses and local paths
remain private. Each private diagnostic variant is retained byte-for-byte and
checked against its run's fingerprints, including the failed prewarm variant.
Earlier evidence in [the foundation review](pre-m4-foundation.md) remains intact.

## Uninstrumented control

The maintained command was rerun against the retained SHA-accelerated native
bundle, with one warmup and five planned measured trials per fresh/reused variant:

```sh
bun run profile:foundation:native --app PREBUILT_APP --output REPORT --samples 5 --warmups 1
```

No LLDB attachment, extra sampling, local Crashpad diagnostic configuration,
watchdog extension or runtime source change was applied. The normal observer,
workload, full asset verification and helper/clone policy remained in force.

| Attempt               | Host exit | CEF shutdown               | Post-exit clone cleanup |
| --------------------- | --------- | -------------------------- | ----------------------- |
| Fresh-profile warmup  | 0         | Completed in 8,205 ms      | Passed                  |
| Reused-profile warmup | 2         | Chromium teardown watchdog | Failed                  |

Both application workloads completed. The backend stopped normally, host state
was released and asset workers stopped before the failed CEF phase. The second
failure was not an observer timeout, cancellation or output overflow. No surviving
process was reported after cleanup, but that does not erase failed clone
qualification. The profile aborted before collecting its planned distribution.
A clean first attempt does not supersede the failed second attempt.

## Owned NetworkService captures

Two separate diagnostic launches attached only to the NetworkService child of
the owned app. Role arguments selected a candidate but did not establish ownership.
The gate required same-user identity, current and original kernel ownership,
matching executable UUID and full executable hash, and revalidation before attach
and after reading. The private helper was opened without following a final symlink,
with a 16 MiB bound and unchanged file identity. The matching CEF module UUID and
exact binary were used for symbol attribution. Both debuggers detached successfully.

The first private prewarm variant failed before launching an app. It is retained
as a preparation failure, not an application trial. The corrected captures yielded:

| Diagnostic                       | Network threads | Tracker blockers | Host outcome                     |
| -------------------------------- | --------------- | ---------------- | -------------------------------- |
| Child stacks                     | 13              | Not read         | Clean exit under instrumentation |
| Child state and starting workers | 13              | 3                | Teardown watchdog, exit 2        |

Both captured the utility main thread in `TaskTracker::CompleteShutdown`, reached
through `ThreadPoolImpl::Shutdown` during child-process destruction. Matching
binary disassembly confirms the child shutdown callsite; this is not inferred
from a nearby exported symbol. The second capture recovered the event and tracker
pointers from verified stack slots, cross-checked their relationship and available
register values, then read the tracker state: 28 explicit bytes total.

The count of three is accounted shutdown-blocking items, not three identified
tasks. The older count of eleven belonged to the browser root, not this utility;
those counts must not be combined. The first child capture did not read the count.

Five identified foreground pool workers were waiting for work in each capture.
Two other threads were still in the thread-type setup call made by Chromium's
`ThreadFunc`, before `delegate->ThreadMain()`. In the second capture, a further
32 bounded bytes recovered their delegate vtables and first virtual function.
Exact binary disassembly identifies both as `WorkerThread::ThreadMain`.

The corresponding system frames resolve to `_pthread_set_properties_self` and
`__bsdthread_ctl`. Attribution used the current system libraries' matching UUIDs
and file-relative addresses without inspecting another process for symbols.
The Chromium source and exact callsite establish that this occurs during initial
thread-type setup, before the worker entry, not while an identified task is running.

Primary version-pinned references:
[ThreadFunc](https://github.com/chromium/chromium/blob/154.0.8037.98/base/threading/platform_thread_posix.cc),
[Apple thread types](https://github.com/chromium/chromium/blob/154.0.8037.98/base/threading/platform_thread_apple.mm),
[WorkerThread](https://github.com/chromium/chromium/blob/154.0.8037.98/base/task/thread_pool/worker_thread.cc),
and [TaskTracker](https://github.com/chromium/chromium/blob/154.0.8037.98/base/task/thread_pool/task_tracker.cc).

## What this does not establish

A snapshot does not measure how long either worker spent in thread-type setup,
prove that these workers own the counted blockers, identify the queued task
sources, or establish a kernel or Chromium deadlock. Debugger attachment pauses
the child and changes watchdog-sensitive execution; its clean exit is not native
qualification and its duration is not a performance result.

A separate, unsandboxed C control created only two threads at a time for each of
background, utility and user-initiated QoS. All six `pthread_set_qos_class_self_np`
calls returned successfully; observed calls were 0.000-0.054 ms at that clock's
resolution. The control had a ten-second alarm and a fifteen-second parent bound.
It does not reproduce the CEF utility environment, but it does not support a
claim that thread-type changes are universally broken on this machine.

No native patch, CEF version change, deadline increase, global QoS change,
security-cloning exemption, sandbox relaxation or forced healthy-child termination
is supported by this evidence or introduced by this pass.

## Maintained diagnostic correction

The control exposed a misleading failure message in `assertCleanCommand`: failed
post-exit cleanup was reported as a timeout/overflow/surviving-descendant error,
before the nonzero host exit was inspected. The reporter now lists only observed
conditions, including simultaneous exit and cleanup failures. It emits bounded
reason strings and counts, never raw child output or process identities.

For the retained failing control, the message is now
`Command failed: unexpected exit 2 (expected 0); post-exit cleanup failed`.
The same outcome still fails, and fixture-retention policy is unchanged. Regression
tests cover all 128 flag combinations and explicit expected nonzero exits. This
is a diagnostic fix, not a CEF runtime fix or a reclassification of old results.

## Remaining acceptance work

Identify the counted task sources and their worker/group ownership, and distinguish
transient startup from a persistent thread-type transition problem. Use bounded,
identity-checked capture and preserve exact binary attribution. Any proposed fix
must explain the failure and add regression coverage for changed Bunly behavior.

Then run the complete maintained native workload and repeated shutdown/helper
qualification without debugger intervention. Keep failed trials and clone outcomes
in the record. Hosted smoke success on another environment is not a replacement
for this workload on the affected machine. Native performance and release
acceptance remain incomplete until that validation succeeds.

## Candidate and reversal controls on October 23

A further unchanged control at harness commit `7e318b1` reproduced the watchdog
on its first warmup, with exit 2 and failed post-exit cleanup. The application
workload and preceding shutdown phases completed. A subsequent sequence tested a
process-local `NSProcessInfo` activity assertion, first for the complete host
lifetime and then only after the message loop returned. Both experiments used the
original CEF watchdog, sandbox, security cloning and asset verification.

| Condition                                          | App launches | Result                                      |
| -------------------------------------------------- | ------------ | ------------------------------------------- |
| Retained original host, initial control            | 1            | Watchdog exit 2; failed clone qualification |
| Activity assertion for host lifetime               | 12           | All completed                               |
| Activity assertion for teardown only               | 12           | All completed                               |
| Rebuilt original sources, no assertion             | 12           | All completed                               |
| Retained original host, repeated control           | 12           | All completed                               |
| Hidden-window 12-second idle, original / assertion | 2 / 2        | Both completed                              |
| Hidden-window 60-second idle, original / assertion | 1 / 1        | Both completed                              |

Crucially, the repeated retained-host control used the **same prepared executable
bytes** as the initial failing control. Its successful run disproves neither the
failure nor an environmental explanation, but prevents attributing improvement to
the experimental patch or rebuilding. The native sources were restored exactly;
**neither activity assertion is retained in the implementation**. No App Nap,
QoS, kernel, or Chromium root cause has been established by these controls.

The hidden-idle runs are separate diagnostics: they finish the original asset
workload, hide the window, idle, and then dispose the backend. The 60-second idle
experiment permits a 90-second total parent observation to accommodate that idle
period; it does not change any native shutdown deadline or count as an ordinary
30-second profile qualification. The native/full-lifetime experiments also remain
candidate diagnostics, not measured application speedups. All outcomes and
byte identities are preserved in the
[control evidence](../evidence/cef-shutdown-controls-2026-10-23.json).

The maintained native profiler now captures partial shutdown state before the
ordinary command-acceptance assertion, and requires all four teardown phases in
order before accepting a completed launch. It also summarizes per-phase elapsed
times for successful trials. This makes incomplete/malformed lifecycle evidence
fail explicitly and preserves the stopping point when exit and cleanup also fail.
It is additional regression protection, **not a runtime cure for issue #92**.
The earlier failure records remain intact, and successful later profiles do not
close that issue or establish production readiness.

### Final maintained profile validation

At clean code checkpoint `eb6b1d52e8c4189a4d1ee45702b332eda19850f1`, the updated
ordinary profiler completed **24 launches**: two warmups and ten measured trials
for each of the fresh/reused profile variants. Every command, complete ordered
shutdown sequence and exact post-exit helper/clone qualification passed. Input
and prepared artifact inventories and harness source hashes were unchanged.
No debugger, activity assertion, hidden-idle extension or native patch was used.

The prepared host executable is byte-identical to the initially failed control.
This is a complete later run, not evidence that the intermittent failure is
fixed. The control evidence retains its per-phase distributions and report hashes
alongside the earlier failure. Native reliability/root-cause issue #92 stays open.

The updated code passed `check:portable` (**626 Bun tests, 199 Python tests**),
`check:foundation` (**139 tests**, overlapping the ordinary suite), and the
focused profile/reporter suite (**28 tests**, also overlapping). Missing or partial
shutdown phases are rejected; replaying the retained watchdog report identifies
`cef-shutdown` as pending and leaves its duration unknown rather than zero.

## CEF 156 sustained PTY investigation (October 25)

**The watchdog is not fixed.** This increment adds a native ownership discriminator
and a maintained, identity-checked, non-suspending thread-state capture command. It does not establish a causal
runtime cure or complete #25, #27, #92, or M5. The coordinator owns review and merge.
See [the attempt ledger](../evidence/cef-shutdown-load-2026-10-25.json).

The supplied adverse baseline is the complete `run-LpSEdA` profile: twelve launches,
seven accepted and five rejected. Visible trial 3 completed all 700 batches and
normal Bun exit before watchdog exit 2. Hidden trial 1 combined a workload deadline,
Bun exit 1, and watchdog exit 2. Both retained one observed utility orphan and failed
post-exit cleanup. The other hidden failures returned normally from CEF. Those
workload failures belong to the separate load investigation; none were reset or
reclassified here.

### What was tested

The specific hypothesis was that Bunly's session initialization/disposal callbacks
or request-context handlers remained retained after the final IO/UI fence, delaying
CEF shutdown. The `shutdown-diagnostics` Cargo feature counts **wrapper lifetimes**
for context handlers, session-ready tasks, flush callbacks, and connection-close
callbacks. Cloned tokens decrement only when their last owner drops. Receipts are
emitted at the final UI fence, before `CefShutdown`, and after its return. These are
not CEF internal reference counts, thread-pool task counts, or a drain barrier.
The default build emits no audit receipt and allocates no audit owner.

A fresh release host and all helper executables were built from this branch with
`packaging,rpc-qualification,shutdown-diagnostics`, placed in a separate private app,
and ad-hoc signed independently. The CEF binary was unchanged:
`d639aafd8cb6dbe7b1aedb7da575d71ce9195c22254345f9ebf54a6260ca9902`.
Its exported identity is CEF 156.0.7 / Chromium 156.0.8078.17. Packaged and developer
Bun are 1.4.3. The source base is `6c01202`; its native source tree is identical to
qualified artifact source `c17d20f7ffdec59de965b9d9d5b944ca65a36128` before the audit
patch. The evidence records exact native source and artifact hashes.

The workload component is independently pinned at
`c23014dbb7f4d04a323ca23c935f1bc9c47c7978`, from #118. Its source was exported privately
without changing the load agent's worktree. Rebundling reproduced both Bun outputs
byte-for-byte; the browser bundle differed only in a generated xterm source-path
comment. Runs retained the original browser bundle bytes. This dual-component
identity must not be described as an all-current-source M5 benchmark. No #118
performance measurement or claimed regression budget was adopted.

The initial stack-sampling experiments produced both a completed visible workload
followed by watchdog exit 2 and a hidden workload deadline followed by watchdog exit 2. **All four audited classes were zero before shutdown in those failures.** A third
stack-sampler invocation, only eight seconds into active workload, also timed out
and preceded a watchdog. All three actual sampler invocations timed out and their
launches ended at the watchdog. They cannot characterize the original uninstrumented
failure: terminating a timed-out suspending sampler is a material confounder. That
sampler implementation was rejected and is retained privately, not shipped. The unchanged
control and later diagnostic runs without stack sampling also returned normally.
One unchanged control spent 8,148 ms in CEF shutdown. Passing runs, rebuilding,
zero counts, or a long successful return do not establish a fix.

### Maintained capture command and limits

```sh
python scripts/capture_cef_shutdown.py PRIVATE_APP NEW_PRIVATE_DIRECTORY --role control --mode visible
python scripts/capture_cef_shutdown.py PRIVATE_APP NEW_PRIVATE_DIRECTORY --role network --mode visible --after 40
```

The caller must supply an independently signed private app already containing the
pinned workload. The command never compiles or changes that app. It uses the existing
90-second load observer, its ordinary orphan/clone rules, and unchanged native
watchdogs. `control` means no stack sampling; the app may still contain the optional
lifetime audit. `host` and `network` collect at most ten read-only libproc thread-state snapshots
250 ms apart (at most 256 threads each). They do not suspend the target or invoke
`sample`, LLDB, signals, or task memory reads. Reports are collection output, not workload or
performance acceptance; inspect command outcomes and replay workload/shutdown gates.

Only the observer's owned root or its unique NetworkService child can be sampled.
The gate requires same-user identity, root birth and kernel identity, live child
ancestry, original-parent kernel identity, and the exact private helper executable.
Identity and executable content are rechecked before and after each snapshot.
Chromium's host signing clone is accepted only when its inode and hash match the
already owned private host. Identical bytes at another inode do not qualify. This
capture-only rule does not change the existing helper cleanup policy. Raw identities
and kernel thread records stay private; the ledger is written before invoking the sampler.

Early attempts exposed an overly strict root pathname check during signing-clone
execution. Those refused captures are retained, and deterministic regressions cover
the corrected same-inode/hash qualification. Refused identities and processes that exit before revalidation never qualify a
snapshot. Run states, bounded thread names, CPU time and sleep time do not identify
queued task sources or establish a deadlock. Short per-thread reads remain explicitly
unavailable. The ABI comes from the installed XNU `sys/proc_info.h`: flavors 6 and 5,
112-byte `proc_threadinfo`; list entries are thread handles, not flavor-15 thread IDs.
No current stack capture is used to claim a Chromium or kernel deadlock.

The remaining discriminator is a bounded capture of the actual Chromium shutdown
work and its blocking task sources on a current adverse run, with uninstrumented
controls. The audited Bunly callback classes do not explain the sampled failures.
There is no evidence here supporting an activity assertion, different watchdog,
forced normal CEF termination, sandbox change, or different CEF binary.

Version-pinned primary source inspected:
[Chromium browser shutdown ordering](https://github.com/chromium/chromium/blob/156.0.8078.17/content/browser/browser_main_loop.cc)
and [NetworkService remote teardown](https://github.com/chromium/chromium/blob/156.0.8078.17/content/browser/network_service_instance_impl.cc).
They locate the teardown boundaries; they do not identify this run's blocking task.

### Validation and scope

Default CEF tests: 155 passed. Contributor tests with the lifetime audit: 161 passed.
Default and contributor Clippy passed with `-D warnings`; default and contributor
release builds passed. The ordinary maintained graphical terminal functional
qualification passed on the new private artifact. These results qualify the
instrumentation/functional scope, not watchdog reliability.

The final ledger retains 23 new launches: 20 passed workload, ordered shutdown and
command gates; three watchdog failures are sampler-confounded. The seven unchanged
control launches all returned normally. Two active-load libproc captures each
completed ten identity-verified snapshots; one late capture found no live target
before process exit, and another retained partial snapshots plus the exit race.
These are diagnostic outcomes, not calibrated measurements or reliability acceptance.

Portable validation passed with 834 Bun tests (one existing Windows-only skip) and
236 Python tests. The attempt ledger records foundation, workflow, doctor, native probe,
host qualification, artifact probe, formatting, hooks and secret checks. Initial
build failures from relocated CMake cache paths and restricted `sccache`, and the
initial sandbox-denied process-observer tests, were retained and subsequently
rerun successfully. No check was weakened. Local native execution is macOS arm64;
Linux/Windows execution, personal credential-provider tests, controlled comparison
benchmarks, and M5 acceptance are not claimed.

Native edits are limited to callback token construction in `host.rs`, the context
handler in `scheme.rs`, the new audit module/feature, and two checkpoints plus its
module declaration in `lib.rs`. No process-spawn/terminal-owner section, window
method, or `window_state.rs` was edited.
