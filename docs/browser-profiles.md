# Browser build profiles (M10, issue #52)

An application chooses a browser profile at build time. The portable Bunly
application model does not change: the same application code is built against
the same contracts, and the profile decides which backend the build targets and
what the resulting artifact may contain.

## The two profiles

| Profile          | Backends                             | Engine in the artifact                        | Prerequisite before the app runs                                                                                               |
| ---------------- | ------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `cef`            | `cef`                                | Yes - the pinned CEF runtime is bundled       | The CEF runtime payload recorded in the artifact manifest must be installed. Bunly never downloads it at run time.             |
| `system-webview` | `webview2`, `wkwebview`, `webkitgtk` | No - the operating system provides the engine | The operating system webview (WebView2, WKWebView, WebKitGTK) must already be present. Bunly neither bundles nor downloads it. |

Both profiles are declared in `packages/contracts/src/profiles.ts`. Selecting a
profile never asks an application developer to compile native code: the
profile is a build-time selection.

## Versioned capability metadata

The capability metadata carries a version (`PROFILE_CAPABILITY_VERSION`,
currently `1`). A backend declares the version it was written against in its
`BackendDescriptor.capabilityVersion`, and `requireCapability` refuses a
backend whose metadata version does not match with `VERSION_MISMATCH` rather
than guessing. The metadata separates:

- **portable guarantees** - the capability floor every backend of the profile
  must provide. `missingProfileCapabilities` names the shortfall instead of
  accepting a backend that cannot meet it.
- **backend extensions** - capabilities a single backend adds. They are never
  portable guarantees and are never assumed for another backend of the profile.

## Deterministic artifact selection

`selectProfileArtifacts` (`packages/artifacts/src/profile-selection.ts`) turns
an artifact inventory into a selection:

- the selection is sorted and carries an inventory metadata digest (`inventoryDigest`), so the same inventory
  always produces the same selection and the same digest;
- a profile that forbids an engine payload refuses a build that contains one -
  the system-webview profile refuses any CEF library, helper or resource;
- a profile that bundles an engine refuses an application artifact without it
  (`requireBundledEngine`, on by default; the portable SDK bundle is not an
  application artifact and opts out);
- an implicit runtime download is refused for every profile.

`scanCefLeakage` reports CEF payloads in an inventory by name, before anything
is downloaded or launched. Known payload names are checked regardless of inventory
labels. This metadata/name scan is not binary-content identification or a replacement
for the signed CEF manifest and full-file verification. The digest identifies sorted
paths, sizes, kinds, profile and target, not file contents.

## Shared backend contract suite

`runBackendConformance` (`packages/runtime/src/conformance.ts`) measures a
backend against the same portable semantics: resource ownership, RPC
authority, navigation, profiles (trust), permissions, supported actions and
reload behaviour. The suite only uses the browser-independent contract, so it
never depends on a native transport.

A check the backend cannot answer is reported as `skipped` **with its reason**,
never as a pass, and an unsupported request must fail with
`UNSUPPORTED_CAPABILITY` rather than silently changing semantics.

## Per-profile resource reporting

`reportProfileResources` (`packages/artifacts/src/profile-resources.ts`)
reports installer size, installed bytes, external runtime downloads, caches and
RAM separately per profile. Every figure carries its source: `measured` or
`not-measured` with the reason. A missing measurement is never reported as
zero.

The build writes `.bunly/profiles/<profile>.json` with the profile metadata,
the deterministic workbench selection and the resource report. The scope is
`sdk-workbench-bundle`, not a packaged application.
Unsupported targets fail rather than being silently mapped to another platform.
Failed builds remove the selected profile's stale manifest and still settle all
parallel writers before returning.

## Adapter status in this tree

Adapters are qualified independently: an unfinished platform does not make
another platform's profile inaccurate.

| Profile          | Platform                           | Backend     | Status                                                               |
| ---------------- | ---------------------------------- | ----------- | -------------------------------------------------------------------- |
| `cef`            | darwin-arm64, linux-x64, win32-x64 | `cef`       | implemented; per-platform native qualification is tracked separately |
| `system-webview` | darwin-arm64                       | `wkwebview` | **not implemented** (issue #49)                                      |
| `system-webview` | win32-x64                          | `webview2`  | **not implemented** (issue #50)                                      |
| `system-webview` | linux-x64                          | `webkitgtk` | **not implemented** (issue #51)                                      |

The shared packaging and conformance work in this tree is usable before every
adapter exists: the profile, the selection rules, the leakage scan, the
contract suite and the resource report are engine-independent.

## What is not claimed here

- No system-webview adapter is implemented in this tree, so no system-webview
  backend was run against the contract suite.
- The CEF backend needs a native host; the contract suite is exercised against
  the mock backend in this tree.
- No native install, CEF download, application launch, packaging run or
  platform qualification was performed. Workbench output bytes appear only in
  `selection.totalBytes`; all five application resource measurements remain
  explicitly not measured. A bundle is not an installer or installed runtime.

The contract suite releases its owned resources on setup and execution failures.
Its RPC checks exercise the TypeScript authority model, not native renderer
authentication. They do not complete M4 security qualification.

## Contributor test environment

Bun test preloading preserves an explicit `PYTHON`, otherwise selects an activated
virtual environment or the repository `.venv` when its interpreter is present.
The shared CI installer places `psutil` there; calling an unrelated system Python
cannot use those dependencies. With no virtual environment, normal caller PATH
resolution remains unchanged. The preload installs nothing, does not alter PATH,
and is not part of application builds or the production runtime.
