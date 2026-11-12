# Architecture decisions

This directory contains **Bun Native** architecture decision records (ADRs). Old Bunly/CEF decisions are superseded and remain in Git history.

ADRs are intended to help an autonomous coding agent make and communicate consequential technical decisions—not to introduce human approval gates.

## When to write an ADR

Record a decision when selecting or changing:

- Native renderer (GPUI is the initial implementation).
- Bun/native interop (FFI, Node-API, subprocess, bridge serialization/threading).
- Public TS/JS API and package boundaries.
- Component/style/DOM compatibility scope.
- Release packaging, ABI versioning, security/capability boundary or update trust.
- A measured performance tradeoff or major dependency addition.

## Format

```markdown
# ADR NNNN — concise title

Status: proposed | accepted | superseded
Date:
Related milestone/issues:
Context and constraints:
Options considered:
Decision and rationale:
Implementation consequences:
Validation and measurements:
Risks, unsupported cases and follow-up:
```

The implementation agent may accept an ADR autonomously within the owner's experimental repo authorization, update affected issues/docs and continue. A significant alternative must still satisfy **Bun TS/JS, genuine browserless native UI and machine-code Bun AOT production**. Do not use a CEF/WebView fallback or invent successful test evidence.

## Numbering

Two records share number 0013. [Release readiness](0013-release-readiness.md)
landed first, in #483, and [owned OS file dialogs](0013-native-file-dialogs.md)
followed in #481. The files keep their names, so existing links stay valid.
Cite either record by its file name, not by "ADR 0013" alone. The highest
number is 0021 and there is no 0016, so the next new record is 0022.

## Current decisions

- [0001 — Bun Native direction](0001-bun-native-direction.md)
- [0002 — Own a separate GPUI process](0002-owned-native-process.md)
- [0003 — Trust, authority and lifetime at the native boundary](0003-bridge-security.md)
- [0004 — Shared public TS/JS application API](0004-public-api.md)
- [0005 — Native service policy and owned-window display reads](0005-native-service-policy.md)
- [0006 — Explicit macOS backing-layer invalidation](0006-macos-backing-layer-invalidation.md)
- [0007 — Bounded native clipboard text worker](0007-native-clipboard.md)
- [0008 — Owned native global shortcuts](0008-native-global-shortcuts.md)
- [0009 — Owned desktop notifications](0009-native-notifications.md)
- [0010 — Scoped filesystem grants](0010-filesystem-grants.md)
- [0011 — Owned child processes](0011-owned-processes.md)
- [0012 — Bounded native drag and drop](0012-native-drag-drop.md)
- [0013 — Owned OS file dialogs](0013-native-file-dialogs.md) (the second 0013; see [numbering](#numbering))
- [0014 — Message and confirm dialogs on the modal overlay](0014-message-dialogs.md)
- [0015 — Application menu bar](0015-application-menu-bar.md)
- [0017 — Wayland qualification and service backends](0017-wayland.md)
- [0018 — Windows task dialogs for message and confirm dialogs](0018-windows-task-dialogs.md)
- [0019 — macOS alert sheets for message and confirm dialogs](0019-macos-alert-sheets.md)
- [0020 — OS context menus](0020-os-context-menus.md)
- [Native host protocol 11](../native-abi.md)
- [Active roadmap](https://github.com/0xPlayerOne/bun-native/issues/1)
- [Architecture overview](../architecture.md)
- [Engineering quality](../engineering-quality.md)

## Release scope

- [0013 — Release readiness and supported scope](0013-release-readiness.md) (the first 0013)
- [0021 — Release readiness by platform: Linux and macOS first, Windows waiting](0021-platform-release-readiness.md) (proposed)
