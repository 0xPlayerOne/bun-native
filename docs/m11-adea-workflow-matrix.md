# M11 — Adea workflow matrix and native-webview blocker classification

**Scope:** issue #53. Identify exactly what prevents the required Adea workflows from running
without CEF, and classify every blocker. This matrix is an inventory, not authorization to
migrate Adea production, and it closes no gate.

**Status:** the workflow rows and the blocker classes below are derived from public and
repository-source evidence. Rows whose reproduction needs the affected Adea backend are marked
as explicit evidence gaps — the issue's own validation rule is that reproductions require the
affected backend, and this milestone does not have it. No private Adea data, account, native
app launch, CEF install or package install is used here.

**Reproducible evidence:** `bun scripts/adea-workflow-matrix.ts` re-derives the wrapper-side
state of every row from this repository's own sources and prints the table below. The
`bun test tests/adea-workflow-matrix.test.ts` run asserts the matrix's structure and the
existence of every cited repository path. The probe's printed output, not this prose, is the
authority for the wrapper-side state.

## Blocker classes

| Class                                         | Meaning                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `wrapper gap`                                 | The Bunly wrapper does not yet expose the capability; it is our integration work.                                                    |
| `application dependency on Chromium behavior` | The Adea workflow needs behaviour only a Chromium-based embedder provides; Bunly cannot add it without a Chromium-equivalent engine. |
| `engine/public-API limitation`                | The underlying engine's public API does not expose the capability at all; no wrapper work can add it.                                |

## Workflow matrix

| Workflow                    | Required capability                                                   | Bunly wrapper state                                                                                                                                         | Blocker class                               | Evidence (reproducer or gap)                                                          | Platform / versions                              | User impact                                                         | Candidate fix / workaround                                                                      | Upstream reference |
| --------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------ |
| Application UI              | Embedded application surface with the host's own chrome               | present: the client and runtime packages carry the view surface; no CEF engine is involved                                                                  | application dependency on Chromium behavior | gap: the Adea desktop shell's own widget behaviour needs the affected backend         | all supported desktops; the CEF-backed path only | the Adea desktop app cannot run on a non-CEF embedder at all        | build the shell's UI against the wrapper's view contract                                        | none identified    |
| Terminals                   | A PTY-backed terminal with resize, signal and exit semantics          | absent: no terminal surface exists under `packages/*/src`                                                                                                   | wrapper gap                                 | fixture: `scripts/adea-workflow-matrix.ts` reports no terminal surface                | all supported desktops                           | any terminal workflow is unavailable                                | add a PTY-backed terminal surface to the wrapper                                                | none identified    |
| Browser control             | DevTools-protocol style inspection and scripting of the embedded view | absent: no devtools or CDP surface exists under `packages/*/src`                                                                                            | wrapper gap                                 | fixture: `scripts/adea-workflow-matrix.ts` reports no devtools surface                | all supported desktops                           | the browser-control workflows cannot be qualified or supported      | expose an inspection channel in the wrapper, or qualify the affected workflows as Chromium-only | none identified    |
| Previews                    | A live preview surface for the app under test                         | absent: no preview surface exists under `packages/*/src`                                                                                                    | wrapper gap                                 | fixture: `scripts/adea-workflow-matrix.ts` reports no preview surface                 | all supported desktops                           | preview workflows are unavailable                                   | add a preview surface to the wrapper                                                            | none identified    |
| Sessions and authentication | A session store with cookies that the app can resume                  | present at the contract layer: the contracts package carries the session and cookie fields; the runtime mock is a test seam                                 | wrapper gap                                 | fixture: `scripts/adea-workflow-matrix.ts` reports the contract-layer session surface | all supported desktops                           | a resumed session is not durable on a non-CEF embedder              | persist the contract's session fields in the wrapper's own store                                | none identified    |
| File workflows              | Host file pickers and an app-visible working directory                | absent: no file-dialog surface exists under `packages/*/src`                                                                                                | application dependency on Chromium behavior | gap: the affected backend's file-picker flow is the Chromium-dependent part           | all supported desktops                           | file workflows are unavailable or need a manual path                | a host-side picker implemented in the wrapper, without a Chromium file chooser                  | none identified    |
| Diagnostics                 | Structured runtime diagnostics and crash evidence                     | present at the runtime layer: the runtime package carries its mock and event surfaces; the artifacts package carries the cache surfaces                     | wrapper gap                                 | fixture: `scripts/adea-workflow-matrix.ts` reports the runtime and artifacts surfaces | all supported desktops                           | diagnostics are thinner than the CEF path                           | extend the runtime diagnostics to the wrapper's own events                                      | none identified    |
| Offline behavior            | A cached, resumable artifact set when the network is unavailable      | present at the artifact layer: `packages/artifacts/src/cache.ts` and `packages/artifacts/src/cef-cache.ts` carry the cache surfaces                         | engine/public-API limitation                | gap: page-level offline behaviour needs the affected backend's service worker         | all supported desktops                           | offline is limited to artifacts, not to a live page                 | keep the artifact cache as the offline contract and state the limit                             | none identified    |
| Input                       | Keyboard, pointer and IME input delivered to the embedded view        | absent: no input surface exists under `packages/*/src`                                                                                                      | wrapper gap                                 | fixture: `scripts/adea-workflow-matrix.ts` reports no input surface                   | all supported desktops                           | input-dependent workflows are unavailable                           | deliver input events through the wrapper's view contract                                        | none identified    |
| Accessibility               | An assistive-technology tree and the automation to drive it           | present at the packaging layer only: `packages/artifacts/src/cef-pack.ts` mentions the aria surface, and no accessibility tree or automation surface exists | engine/public-API limitation                | gap: the accessibility tree needs the affected backend's automation surface           | all supported desktops                           | the app cannot be qualified for accessibility on a non-CEF embedder | qualify accessibility on the CEF path and state the limit for the others                        | none identified    |

## Rendering capability (WebGL / WebGPU)

The selected workflows above do not require WebGL or WebGPU, so the capability is **not tested**
here, per the issue's rule. The wrapper exposes no graphics surface of its own
(`packages/*/src` has no webgl or webgpu surface), and a WebGPU path would be an
`engine/public-API limitation` rather than a wrapper task. That is stated as a claim boundary,
not as a tested result: no native app was launched and no CEF runtime was installed.

## Prioritisation by workflow value

1. **Application UI** — the gate for every other workflow; it is the Chromium-dependent root
   cause, and it needs the affected backend to qualify.
2. **Sessions and authentication** — the contract already carries the fields, so a wrapper-side
   store is the cheapest durable win.
3. **Terminals and input** — self-contained wrapper work with a clear contract.
4. **Browser control and previews** — wrapper work, but only after the UI surface exists.
5. **File workflows** — needs a host-side picker; the Chromium chooser is not portable.
6. **Diagnostics** — an extension of the existing runtime events, not a new surface.
7. **Offline behavior and accessibility** — engine/public-API limits that the wrapper cannot
   add; they are stated limits, not work items.

## What this milestone does not establish

No workflow is claimed to work on a non-CEF embedder, no Chromium parity is promised, and no
engine capability is assumed addable by wrapper work. Rows marked as evidence gaps stay open
until the affected backend is available; the matrix does not authorize a production migration,
a CEF install, an account use, or a package install.
