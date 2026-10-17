# Contributing to Bunly

Keep the experiment reproducible and its support claims narrow.

**Status:** M1 foundation.

## Application-side development

Install Bun 1.4.3, then run `bun install --frozen-lockfile`, `bun run check`,
`bun run typecheck:browser`, and `bun run example`. These commands do not need a
native compiler. The example is a mock contract fixture, not a native application.
`bun run build` bundles packages and the browser example; M3/M8 provide actual
desktop application assembly.

## Native framework work

Install rustup and the repository's pinned 1.85.1 toolchain. Run
`bun run native:test`, `bun run native:build`, `bun run qualify:host`, and
`bun run artifact:probe`. Windows requires the usual MSVC linker/build tools for
framework contributors; macOS requires Xcode command-line tools; Linux requires
a C linker and binutils. These are not future application-consumer requirements.

Do not edit the Bun or Rust pins without updating compatibility evidence. Keep
one Bun lockfile and the native workspace Cargo lockfile. A Cargo lockfile is not
a competing JavaScript package manager.

## Tests and evidence

Tests use the Node test API supported by Bun, and portable tests can also run on
Node 22 with TypeScript stripping. Node results do not qualify Bun-native APIs.
The browser-only typecheck deliberately has no Node/Bun ambient types. The AST
boundary check rejects native dependencies and host globals in browser packages.

Native qualification produces `.bunly/qualification/host-<target>.json`. CI uploads
these and actual native artifacts for Linux x64, macOS arm64, and Windows x64.
Inspect errors rather than marking an unsupported candidate as passed. Headless
native probes do not prove display, GPU, input, sandbox, or CEF support.

The restricted artifact format rejects unsupported tar features rather than
trying to interpret every archive. Its private-cache threat model excludes an
actively hostile same-user process. Production keys and update metadata are not
configured. Do not publish CI fixture keys as a release trust root.

## Changes

Link the issue and acceptance evidence in the PR. Use `Closes #...` only for
completed acceptance criteria; use `Refs #...` for partial work. Keep independent
work parallel and do not create blanket milestone blockers. Never weaken security,
output integrity, accessibility, or cleanup to improve a performance number.

Record any source imports in provenance. Do not commit `.env`, keys, private
account data, downloaded browsers, node_modules, crash dumps, or build output.
Keep scope separate from Adea production, Agent Sim, and unrelated fleet changes.
