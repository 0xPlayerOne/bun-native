# M3 native platform acceptance

Explicit functional qualification without changing shipping deadlines or sandbox policy.

**Scope:** M3 #13 Windows and #14 Linux after merged #80.
**Status:** Implementation and execution in progress; no new platform acceptance claimed by this document alone.

## Deadline profiles

The normal native startup/request/browser-close/backend-exit deadlines remain
10 seconds, 10 seconds, 8 seconds and 2 seconds. They do not automatically change
when a startup fails or when a virtual machine is detected.

A private runtime configuration can explicitly select
`qualification_profile: "emulated-functional"`. This finite functional-test profile
uses 60/30/30/5 seconds respectively. Native readiness binds the request deadline
to that profile; arbitrary or contradictory deadline values are rejected.
Successful smoke records must attest the selected profile in native diagnostics.

The profile changes no security policy, sandbox flag, frame authority, workload,
cycle count or cleanup criterion. All timeouts remain failures. The production
signed-cache validator still rejects any qualification-profile field, including
one in an otherwise valid signed artifact. A qualification copy is not a shipping
artifact and cannot be silently promoted into the production cache.

`qualify-cef-prebuilt.ts` and `qualify-cef-development.ts` accept an explicit
`--emulated-functional` argument; the fault runner accepts the same named flag.
Process observation is bounded to five minutes per invocation in that profile.
The public page deadline is one minute. There is no retry with a slower profile
or an alternate browser after failure.

## Readiness correction

Development and fault page timers start only after native view creation returns,
while their listeners are installed before creation. This separates native creation
from page readiness without missing early completion events.

The public packaged-page fixture now waits for the actual `connect-src` and
`frame-src` CSP violation events for its blocked origin. A fixed 100 ms sleep was
not proof that those asynchronous events had arrived. Missing, duplicate or
unrelated violations cannot pass; the observation has its own finite deadline,
removes its listeners on every outcome, and leaves the actual CSP unchanged.

## Evidence boundaries

An emulated-functional run proves only the reported native OS/application
functionality with that explicit timing profile. It is not a standard-deadline
startup pass, a native-hardware performance result, a physical input/DPI test,
or proof of hardware GPU acceleration. Preserve failed standard-profile results
and initial prerequisite failures alongside any later qualified executions.

All work uses private benchmark VMs and contributor-built native artifacts.
Consumers run prebuilt executables and bundled Bun; they never compile Rust as
part of the smoke script. No hosted Actions job is dispatched and the billing
pause remains in effect.
