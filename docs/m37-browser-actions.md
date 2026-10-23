# M37 — portable browser actions and secure diagnostics

**Scope:** issue #37. A portable, engine-neutral API for observing and controlling
approved browser views, with the engine-specific details (CEF, CDP) isolated in the
adapter. The raw CDP surface stays an engine-specific debug extension; it is not the
public SDK's only browser-control interface.

**Status:** the action vocabulary, the authorization binding and the diagnostic
bundle are implemented in new files under `packages/runtime/src/`. The embedder
adapter is injected, so nothing here launches a native app, installs a webview, or
talks to a provider. The public export registration in
`packages/runtime/src/index.ts` is **not** made here: that is a shared source path,
and it is left for reconciliation with the concurrent issue #52 work.

## Capabilities

| Action               | Capability           | Requirement                                                             |
| -------------------- | -------------------- | ----------------------------------------------------------------------- |
| `navigate`           | `navigate`           | the target origin must be the view's authorized origin                  |
| `screenshot`         | `screenshot`         | bounded by the policy's maximum size                                    |
| `snapshot`           | `snapshot`           | debug surface: opt-in, authenticated, off in packaged production builds |
| `evaluate`           | `evaluate`           | debug surface, and only an **approved** expression                      |
| `observe-dom`        | `observe-dom`        | observation only                                                        |
| `accessibility-tree` | `accessibility-tree` | observation only                                                        |
| `input`              | `input`              | the view must allow the input capability                                |

A capability the embedder does not implement, or that the view does not allow, is the
explicit `unsupported-capability` error. It is never a silent no-op and never a
pretended CDP compatibility.

## The binding rule

Every action is bound to an authorized `(viewId, sessionId)` pair and to the epoch the
host last observed. A request for another session is `unauthorized-target`; a request
for a superseded epoch is `stale-target`; a navigation that does not advance the
epoch is `navigation-race`; a navigation that leaves the authorized origin is
`cross-origin-frame`. Remote content therefore never gains application-native
authority by being controlled: the authority comes from the host's authorization, not
from the page.

## Diagnostics

`collectDiagnosticBundle` redacts secrets and home paths and bounds the bundle, and
reports `truncated` when it had to cut records. A stack frame is rendered through a
supplied source map only; with no usable mapping the frame is reported as captured
rather than given an invented position. Renderer, RPC-stage and reload-stage records
share the same bounded, redacted bundle.

## Debug endpoints

The debug-only actions (`evaluate`, `snapshot`) require the debug surface to be
enabled, the caller to be authenticated, and the build not to be a packaged production
build. A packaged production build refuses them with `diagnostics-disabled`
whatever the caller asks for.

## Unavailable capabilities

Documented explicitly: no cross-origin observation, no unapproved evaluation, no
screenshot above the bounded size, and no debug surface in a packaged production
build. A future webview adapter is not expected to pretend full CDP compatibility —
it declares the capabilities it implements, and the rest stay named errors.
