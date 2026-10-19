# M2 native-signing acceptance

Opt-in platform signing and separate verification for the existing release runner.

**Base:** merged PR #73 (`3c67a84febaf85db49e9a93d4697f71ef223e890`).
**Scope:** #9's signed-release stage and post-signing installed-size boundary.
**Status:** implemented; macOS/Windows signing execution remains unqualified.

## Behavior

`scripts/native_signing.py` adds a `release-sign` task to an existing release plan.
The task executes the native signing program, then a separate verifier process.
A signing program returning zero is not sufficient for the stage to pass.

The certificate must already be available to the signing user. There is no key
import, certificate-store mutation, trust-root installation, implicit certificate
selection, execution-policy bypass, administrator override or publishing action.
Do not configure a production signing identity until the selected artifacts and
signing targets have been reviewed. Signatures represent the selected publisher.

The policy selects exact targets, an exact certificate fingerprint, and public
entitlement files by SHA-256 when needed. Windows additionally pins the selected
SDK SignTool executable by SHA-256. macOS targets are signed inside-out; the root
app must be last. There is no recursive `--deep` signing. Native verification does
use `--deep --strict` on macOS, with a requirement fixing the certificate, team,
and root bundle identifier. Timestamp and hardened-runtime metadata are required.

Windows uses `signtool sign` with SHA-256 file/RFC3161 digests and an explicitly
selected HTTPS timestamp authority. Verification uses `signtool verify /pa /all
/tw` and the read-only `Get-AuthenticodeSignature` helper. Valid Authenticode,
the exact certificate and a timestamp are required; a catalog signature does not
substitute for the embedded signature. The certificate SHA-1 value is an identity
selector, not the artifact digest or signature algorithm.

## Policy examples

Examples contain invalid placeholders deliberately. They cannot sign by accident.
Paths are relative to the generated benchmark workspace, not an installed user app.

```json
{
  "schema": 1,
  "platform": "darwin",
  "artifact": "build/BunlyReference.app",
  "certificateSha1": "REPLACE_WITH_REVIEWED_40_HEX_FINGERPRINT",
  "teamId": "YOURTEAMID",
  "bundleIdentifier": "dev.bunly.reference",
  "targets": [
    {
      "path": "build/BunlyReference.app/Contents/Frameworks/ExampleHelper.app",
      "entitlements": {"path": "helper.plist", "sha256": "REPLACE_WITH_64_HEX_DIGEST"}
    },
    {"path": "build/BunlyReference.app"}
  ]
}
```

List the actual native framework, helper, and application targets from the built
artifact. The example is not a complete Mirin/CEF signing inventory. Canonical
paths must not traverse symlinked ancestors; the full inventory may preserve
internal framework links. Entitlements are never inferred, added, or relaxed.

```json
{
  "schema": 1,
  "platform": "win32",
  "artifact": "build/BunlyReference",
  "certificateSha1": "REPLACE_WITH_REVIEWED_40_HEX_FINGERPRINT",
  "signtool": {"path": "C:\\SDK\\bin\\signtool.exe", "sha256": "REPLACE_WITH_64_HEX_DIGEST"},
  "timestampUrl": "https://your-reviewed-timestamp-authority.example/rfc3161",
  "targets": [{"path": "build/BunlyReference/BunlyReference.exe"}]
}
```

Windows target coverage is the explicit PE list, not an assertion that every DLL
in the directory has the same publisher. Existing third-party signatures are not
implicitly replaced. Normal PowerShell execution policy must permit the verifier;
the runner will fail rather than bypass a restriction.

## Connect to the existing release runner

Obtain an unsigned plan with the existing `prepareReferenceRelease` API before
executing its tasks. For example, application-side setup code can call:

```ts
import { prepareReferenceRelease } from '../benchmarks/adapters/references/release-plan.ts';
const plan = await prepareReferenceRelease('mirin', project, frozenLock, lockSha256);
await Bun.write(`${project}/unsigned-plan.json`, JSON.stringify(plan, null, 2));
```

`project`, `frozenLock` and `lockSha256` are the same inputs used by the existing
reference release qualifier. The project must be fresh; do not first execute an
unsigned release and then reuse that already-built directory for a cold trial.

From the repository root, prepare the signed plan with a reviewed policy digest:

```sh
python scripts/native_signing.py prepare /path/to/reviewed/policy.json POLICY_SHA256 \
  --workspace .bunly/signed-reference \
  --base-plan .bunly/signed-reference/unsigned-plan.json \
  --output signed-plan.json

bun scripts/qualify-release-stages.ts \
  .bunly/signed-reference/signed-plan.json \
  .bunly/signed-reference \
  .bunly/benchmarks/signed-release.json
```

`prepare` copies only the reviewed policy and hash-matching public entitlement
plists into a private workspace capsule, rewrites those public plist paths, and
pins the copied policy's new hash. It does not copy private keys or native tools.
The `plan` subcommand supports a policy already located inside the workspace.
Neither subcommand overwrites an existing plan or policy capsule.

The generated task uses the existing observed-command and deadline machinery.
The independent receipt matches the stage nonce, run ID, policy digest, target
count, and exact signed inventory. Mutation after signing or during verification
fails. The native-program helper bounds captured output and process waits; the
outer process observer remains responsible for descendant cleanup.

## Accounting and failure semantics

Installed-byte measurement moves from `app-assembly` to the verified `release-sign`
stage so the value includes signature bytes. The original fresh-artifact check is
preserved as the first assembly command. Compression, configured first-run, and
configured update tasks depend on signing; a failed signature cannot accidentally
produce a successful downstream release stage.

The signature receipt separates native signing-command time from inventory work.
The release runner's stage duration still includes startup, hashing, verification,
and observer overhead. Timestamp/revocation traffic is not included in PR #73's
application-body download counter and is not falsely reported as zero.

A failed signer may leave a partially signed benchmark artifact. It is not a
successful release and is not silently rolled back or retried. Use a fresh private
workspace for another trial. No installed application is updated by this tool.

## Validation and remaining requirements

`python tests/native_signing_test.py` exercises policies, command construction,
path/order guards, real bounded subprocesses, exclusive plan/receipt I/O, stale
input rejection, and distribution-stage ordering. Its simulated native-signature
round trip explicitly mocks the platform APIs; it is not a native signature result.
The wrong-platform CLI test proves that Linux cannot issue a successful signing
receipt for a declared macOS/Windows policy.

Successful macOS/Windows runs with reviewed installed certificates, complete target
lists, actual SDK tools and timestamps remain required. Notarization, Gatekeeper,
SmartScreen, installed first-run/updater behavior, renderer sandboxing, and controlled
performance are separate acceptance results. M2 and #9 remain open.

Source inventory assumes an isolated trusted workspace: it is not a defense against
an adversarial same-user filesystem race. It checks file content/modes and internal
links, not ACLs, extended attributes, or power-loss durability. Hard-linked input
files and Windows reparse-point paths are rejected rather than signed in place.

## Primary references

- Apple: [Code Signing Tasks](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html).
- Apple: [macOS Code Signing In Depth](https://developer.apple.com/library/archive/technotes/tn2206/_index.html).
- Microsoft: [SignTool](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/signtool).
- Microsoft: [Get-AuthenticodeSignature](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature).

This is original benchmark integration code, not copied platform implementation.
No runtime/native SDK, root dependency, CI workflow, billing or Adea change is needed.
