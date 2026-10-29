# M2 first-run and update transfer accounting

Count verified artifact body bytes separately from installation and application outcomes.

**Scope:** #9; optional transfer input to the existing release workflow.
**Base:** merged PR #72, `ab7896ee1fb40a9d17dacbf0c1f99b0ca3cde114`.
**Status:** Implemented and locally exercised; not complete desktop or competitor acceptance.

## What executes

A `ReleaseTask` may now declare an explicit `transfer`. Only `first-run` may
measure `first-run-download`, and only `update` may measure update transfers.
The controller downloads that artifact before running the task's existing
commands and independent nonce-bound verifier. Existing plans do not start
making network requests implicitly; their unsupported stages remain unsupported.

```ts
const task = {
  ...reviewedFirstRunTask,
  transfer: {
    category: 'first-run-download',
    url: reviewedArtifact.url,
    allowedOrigins: reviewedArtifact.origins,
    path: 'downloads/application.tar.gz',
    expectedBytes: reviewedArtifact.bytes,
    sha256: reviewedArtifact.sha256,
    maxRedirects: 0,
  },
};
```

This is a task fragment, not a complete plan. `validateReleasePlan` still requires
one disposition for every stage. Use `runReleaseWorkflow` or the existing
`scripts/qualify-release-stages.ts` entry point with the complete reviewed plan.
Upstream reference recipes still need their real launch/update commands and
verified distributions; this extension does not invent those inputs.

## Measurement semantics

The `transfers` report records actual bytes yielded by the HTTP artifact-body
stream, the pinned and observed hashes, redirects, elapsed transfer/verification
work, publication and cleanup outcomes. It does not infer bytes from cache growth,
Content-Length alone, or installed file size. Transfer timings include output I/O
and hash verification, not just time on the network.

Bun's automatic decompression is explicitly disabled and identity encoding is
requested. Encoded responses are rejected. A gzip **file** served without an HTTP
Content-Encoding header is measured as the received gzip file. HTTP headers,
redirect bodies, TLS/TCP traffic, transport retries and traffic made by child
processes are outside this accounting. It is not full-process network telemetry.

A successful transfer followed by a failed application command retains the known
received-body measurement, but the first-run/update stage **fails**. A corrupt or
incomplete transfer retains failure diagnostics but supplies no verified byte
observation and cannot launch the next command. Dependent stages remain blocked.
Full stage coverage still requires successful execution and independent validation
of every stage; downloading an archive is not first-launch or updater acceptance.

## Boundaries

URLs and allowed origins are explicit. HTTPS is required except for an explicitly
opted-in numeric-loopback HTTP fixture. Redirects are manual, bounded and checked
against the origin list; HTTPS cannot downgrade. Existing proxy settings and TLS
validation are not disabled or replaced. URL paths, queries and arbitrary fetch
errors are not copied into receipts.

Lengths and hashes are caller-pinned, not downloaded from the same untrusted
location. This is benchmark input integrity, not a release-signing trust root.
No payload is extracted or executed by the transfer helper. Commands remain
trusted, explicitly configured local operations.

The destination must be new and contained in the supplied workspace. Observed
linked parents and nonportable paths are rejected. Content streams to a private
staging file, then exact length/hash verification precedes no-clobber hard-link
publication. An intervening destination cannot be overwritten. Failures remove
owned temporary files; incomplete cleanup blocks later workflow work. This assumes
a private workspace, not protection against a hostile same-user filesystem racer.
No claim of full power-loss durability or preemption of stalled OS file I/O is made.
The hard-link publication path needs Windows/macOS qualification before a broader
platform claim; unsupported filesystems fail instead of silently switching modes.

## Executed validation

On Linux x64 with actual Bun (version redacted) and Python/psutil 7.2.2:

- `bun test tests/artifact-transfer.test.ts tests/release-transfers.test.ts tests/release-workflow.test.ts`:
  **37 passed**, comprising 20 new transfer/integration cases and 17 unchanged
  release-workflow cases recovered and hash-checked against merged main.
- Actual HTTP cases cover chunked bodies, invalid encoding/length/hash, redirects,
  denied origins, stalled-body cancellation, output collisions and linked parents.
- Actual first-run/update integration downloads two small local fixture revisions,
  invokes separate application-step and verifier processes, checks retained fixture
  profile state, and records different transfer sizes. These are fixture execution
  results, **not Mirin/Butter/Electron/Electrobun desktop measurements**.
- The existing archive/compression, command failures, cancellation, stale verifier,
  output inventory and dependency tests continue to pass.
- TypeScript and browser-only typechecking, Oxlint, browser boundaries and
  compiler-free builds pass on the retained source set. `bun run check` reports
  **184 passed across 23 files**; this is not the complete latest-main suite.
- The current observer and command wrapper were restored with exact main blob
  hashes. All seven existing real-process qualification cases pass.

## Remaining acceptance

The fresh sandbox-enabled frontend retry still fails at initial navigation with
`ERR_BLOCKED_BY_ADMINISTRATOR`; no browser policy or sandbox was bypassed. Connected
macOS devices were offline. Exact competitor installations, their reviewed locks,
platform signing identities, real desktop first-run/updater transactions and
controlled hardware measurements were not available for this run.

#8, #9 and #10 remain open. No Windows/macOS rerun, fresh native browser execution,
platform signature verification, production trust or competitor advantage is
claimed. The new files do not modify CI/billing guards, publishing, native runtime,
root dependencies, Code Foundry or Adea.

Implementation references: [Bun fetch request options](https://bun.com/docs/runtime/networking/fetch)
and [Node file-handle writes](https://nodejs.org/download/release/v24.20.0/docs/api/fs.html).
The pinned Bun behavior was additionally exercised by the local HTTP tests.
