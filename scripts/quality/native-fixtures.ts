import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Framework } from '../native/bundle.ts'
import { nativeSourcePaths } from '../../experiments/aot-gpui/native-sources.ts'

/**
 * The native CI fixtures that `experiments/aot-gpui/build-window.ts` builds: one record
 * per `--entry`. `framework` entries are bundled with the shared application bundler
 * (scripts/native/bundle.ts) and their module is compiled; the others are compiled
 * directly. `declared` lists inputs no bundler sees: OS oracles and peers the native
 * drivers build, and driver-side helpers.
 */
export type Fixture = { path: string; framework?: Framework; declared?: readonly string[] }

/** The macOS drivers move the window through these and the SDK helper. */
const macosDriver = [
  'tests/native/macos-window-input.ts',
  'tests/native/png.ts',
  'scripts/quality/native-platform-macos.m',
  'tests/native/macos-accessibility-oracle.m',
]
/** Drag sources for X11, macOS and Windows, started by the drag-and-drop drivers. */
const dragSources = [
  'tests/native/drag-source.ts',
  'native/gpui-host/examples/xdnd-source.rs',
  'tests/native/macos-drag-source.m',
  'tests/native/windows-drag-source.cs',
]

export const fixtures = {
  'native-window': { path: 'examples/native-window/main.ts' },
  'input-race': { path: 'tests/native/input-race.ts' },
  bridge: { path: 'benchmarks/bridge.ts' },
  javascript: { path: 'tests/native/javascript.js' },
  'core-lifecycle': { path: 'tests/native/public-lifecycle.ts' },
  'event-throughput': { path: 'tests/native/event-throughput.ts' },
  fault: { path: 'tests/native/fault.ts' },
  scheduling: { path: 'tests/native/scheduling.ts' },
  layout: { path: 'tests/native/layout.ts' },
  'layout-style': { path: 'tests/native/layout-style.ts' },
  interactions: { path: 'tests/native/interactions.ts' },
  services: { path: 'tests/native/services.ts' },
  'display-semantics': { path: 'tests/native/display-semantics.ts' },
  'display-platform': { path: 'tests/native/display-platform.ts' },
  'display-wayland': { path: 'tests/native/display-wayland.ts' },
  'display-virtual-macos': { path: 'tests/native/display-virtual-macos.ts' },
  clipboard: { path: 'tests/native/clipboard.ts' },
  'global-shortcuts': { path: 'tests/native/global-shortcuts.ts' },
  notifications: { path: 'tests/native/notifications.ts' },
  'filesystem-grants': { path: 'tests/native/filesystem-grants.ts' },
  'app-menu': { path: 'tests/native/app-menu.ts' },
  processes: { path: 'tests/native/processes.ts' },
  'file-dialogs': { path: 'tests/native/file-dialogs.ts' },
  overlays: { path: 'tests/native/overlays.ts' },
  'message-dialogs': { path: 'tests/native/message-dialogs.ts' },
  popups: { path: 'tests/native/popups.ts' },
  wayland: { path: 'tests/native/wayland.ts' },
  'drag-drop': { path: 'tests/native/drag-drop.ts' },
  'solid-drag-drop': { path: 'tests/native/solid-drag-drop.tsx', framework: 'solid' },
  'react-drag-drop': { path: 'tests/native/react-drag-drop.tsx', framework: 'react' },
  'text-input': { path: 'tests/native/text-input.ts' },
  ime: { path: 'tests/native/ime.ts' },
  accessibility: { path: 'tests/native/accessibility.ts' },
  'accessibility-platform': { path: 'tests/native/accessibility-platform.ts' },
  'input-states-platform': { path: 'tests/native/input-states-platform.ts' },
  'screen-reader': { path: 'tests/native/screen-reader.ts' },
  'ime-platform': { path: 'tests/native/ime-platform.ts' },
  'solid-services': { path: 'tests/native/solid-services.tsx', framework: 'solid' },
  'react-services': { path: 'tests/native/react-services.tsx', framework: 'react' },
  'platform-smoke': { path: 'tests/native/platform-smoke.ts' },
  'solid-platform': { path: 'tests/native/solid-platform.tsx', framework: 'solid' },
  'react-platform': { path: 'tests/native/react-platform.tsx', framework: 'react' },
  solid: { path: 'examples/solid-counter/main.tsx', framework: 'solid' },
  'solid-workspace': { path: 'examples/solid-workspace/main.tsx', framework: 'solid' },
  'adea-components': { path: 'examples/adea-components/main.tsx', framework: 'solid' },
  'solid-workspace-flow': { path: 'tests/native/solid-workspace.tsx', framework: 'solid' },
  'solid-workspace-soak': { path: 'tests/native/solid-workspace-soak.tsx', framework: 'solid' },
  'solid-workspace-terminal': {
    path: 'tests/native/solid-workspace-terminal.tsx',
    framework: 'solid',
  },
  'solid-input-intent': { path: 'tests/native/solid-input-intent.tsx', framework: 'solid' },
  'solid-interactions': { path: 'tests/native/solid-interactions.tsx', framework: 'solid' },
  'solid-input-viewport': { path: 'tests/native/solid-input-viewport.tsx', framework: 'solid' },
  'solid-streaming-list': { path: 'tests/native/solid-streaming-list.tsx', framework: 'solid' },
  'solid-layout-style': { path: 'tests/native/solid-layout-style.tsx', framework: 'solid' },
  react: { path: 'examples/react-counter/main.tsx', framework: 'react' },
  'react-workspace': { path: 'examples/react-workspace/main.tsx', framework: 'react' },
  'react-workspace-flow': { path: 'tests/native/react-workspace.tsx', framework: 'react' },
  'react-workspace-soak': { path: 'tests/native/react-workspace-soak.tsx', framework: 'react' },
  'react-workspace-terminal': {
    path: 'tests/native/react-workspace-terminal.tsx',
    framework: 'react',
  },
  'react-interactions': { path: 'tests/native/react-interactions.tsx', framework: 'react' },
  'react-input-viewport': { path: 'tests/native/react-input-viewport.tsx', framework: 'react' },
  'react-streaming-list': { path: 'tests/native/react-streaming-list.tsx', framework: 'react' },
  'react-layout-style': { path: 'tests/native/react-layout-style.tsx', framework: 'react' },
  'react-behavior': { path: 'tests/native/react-behavior.tsx', framework: 'react' },
  'react-workload': { path: 'benchmarks/solid/react.tsx', framework: 'react' },
} satisfies Record<string, Fixture>

export type FixtureName = keyof typeof fixtures

/** Fixtures that may run against a host of undeclared profile; every other needs dev or release. */
export const unprofiled: ReadonlySet<FixtureName> = new Set([
  'native-window',
  'input-race',
  'javascript',
  'accessibility-platform',
])

export function isFixture(value: string | undefined): value is FixtureName {
  return typeof value === 'string' && Object.hasOwn(fixtures, value)
}

/** A native CI job that compiles fixtures ahead of its suite steps. */
export type CiPlatform = 'linux' | 'darwin' | 'win32'

/**
 * The fixtures each native CI shard compiles in its one parallel "Compile and
 * inspect" step (`scripts/quality/compile-aot-entries.ts`), before its suite
 * steps run them. A suite moved between shards moves its entries here;
 * tests/quality/native-ci-entries.test.ts fails while a shard's steps run an entry
 * this table does not compile there, or this table compiles one nothing uses.
 * Steps of other shards still compile their fixtures inline.
 */
export const ciCompiles: Record<CiPlatform, Partial<Record<number, readonly FixtureName[]>>> = {
  linux: {
    1: [
      'native-window',
      'input-race',
      'bridge',
      'javascript',
      'core-lifecycle',
      'event-throughput',
      'fault',
      'scheduling',
      'layout',
      'interactions',
      'solid-workspace-terminal',
      'react-workspace-terminal',
    ],
    2: [
      'services',
      'display-semantics',
      'display-wayland',
      'clipboard',
      'global-shortcuts',
      'notifications',
      'overlays',
      'message-dialogs',
      'popups',
      'wayland',
      'filesystem-grants',
      'text-input',
      'accessibility',
      'screen-reader',
      'ime',
      'processes',
      'file-dialogs',
      'drag-drop',
      'solid-drag-drop',
      'react-drag-drop',
      'solid-services',
      'react-services',
      'solid',
      'solid-input-intent',
      'solid-interactions',
      'react',
      'react-interactions',
      'react-behavior',
      'react-workload',
      'react-workspace',
      'react-workspace-flow',
    ],
  },
  darwin: {
    2: [
      'platform-smoke',
      'fault',
      'processes',
      'solid-platform',
      'react-platform',
      'filesystem-grants',
      'app-menu',
      'accessibility-platform',
      'overlays',
      'layout-style',
      'solid-layout-style',
      'react-layout-style',
      'accessibility',
      'input-states-platform',
      'screen-reader',
      'ime-platform',
      'display-platform',
      'display-virtual-macos',
      'drag-drop',
      'solid-drag-drop',
      'react-drag-drop',
    ],
  },
  win32: {
    2: [
      'platform-smoke',
      'fault',
      'processes',
      'solid-platform',
      'react-platform',
      'filesystem-grants',
      'accessibility-platform',
      // The experimental Windows screen-reader and IME steps run on main only.
      'screen-reader',
      'ime-platform',
      'display-platform',
      'drag-drop',
      'solid-drag-drop',
      'react-drag-drop',
    ],
  },
}

/**
 * Entries a shard compiles only to prove the example builds through inspected
 * AOT; no suite step runs them.
 */
export const ciCompileOnly: ReadonlySet<FixtureName> = new Set(['react-workspace'])

/** Package directories (under the evidence directory) that are not `<entry>-package`. */
export function ciPackageDirectory(platform: CiPlatform, entry: FixtureName): string {
  if (platform === 'linux' && entry === 'native-window') return 'package'
  if (platform !== 'linux' && entry === 'platform-smoke') return 'aot-package'
  return `${entry}-package`
}

const declared: Partial<Record<FixtureName, readonly string[]>> = {
  'layout-style': macosDriver,
  'solid-layout-style': macosDriver,
  'react-layout-style': macosDriver,
  overlays: macosDriver,
  accessibility: macosDriver,
  'input-states-platform': macosDriver,
  'solid-workspace-terminal': macosDriver,
  'react-workspace-terminal': macosDriver,
  clipboard: ['native/gpui-host/examples/clipboard-peer.rs'],
  'drag-drop': dragSources,
  'solid-drag-drop': dragSources,
  'react-drag-drop': dragSources,
  // The workload manifests bind every shared workload helper, imported or not.
  'react-workload': [
    'benchmarks/solid/ownership.ts',
    'benchmarks/solid/retention-evidence.ts',
    'benchmarks/solid/sources.ts',
    'benchmarks/solid/workload.ts',
  ],
}

/** Inputs of every fixture: pins, locks, package manifests and the native host sources. */
const common = [
  'examples/native-window/main.ts',
  'examples/native-window/content.ts',
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig.json',
  'packages/core/package.json',
  'packages/protocol/package.json',
  'packages/runtime/package.json',
  '.bun-version',
  'rust-toolchain.toml',
  'toolchain.json',
  'Cargo.toml',
  'Cargo.lock',
  'native/gpui-host/Cargo.toml',
  'native/protocol/Cargo.toml',
  'experiments/aot-gpui/native-sources.ts',
]

/** The bundler and transform an application module depends on, per framework. */
const frameworkInputs: Record<Framework, readonly string[]> = {
  solid: [
    'packages/solid/package.json',
    'packages/renderer/package.json',
    'scripts/native/bundle.ts',
    'scripts/solid/transform.ts',
    'scripts/solid/preset.d.ts',
  ],
  react: [
    'packages/react/package.json',
    'packages/renderer/package.json',
    'scripts/native/bundle.ts',
  ],
}

export type SourceRecord = { path: string; bytes: number; sha256: string }

async function digest(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { bytes: statSync(path).size, sha256: hash.digest('hex') }
}

/**
 * Every source an AOT fixture depends on, sorted and hashed. `modules` are the
 * bundler's metafile inputs (relative to `source`); installed packages are bound
 * by `bun.lock` instead. The core, protocol and runtime sources and the native host
 * sources are always included, so the `native-window` inventory is the one
 * `benchmarks/native-baseline.py` verifies.
 */
export async function fixtureInventory(
  source: string,
  name: FixtureName,
  modules: readonly string[]
): Promise<SourceRecord[]> {
  const fixture: Fixture = fixtures[name]
  const paths = new Set<string>([fixture.path, ...common, ...(declared[name] ?? [])])
  if (fixture.framework) for (const path of frameworkInputs[fixture.framework]) paths.add(path)
  for (const path of modules) if (!path.startsWith('node_modules/')) paths.add(path)
  for await (const path of new Bun.Glob('packages/{core,protocol,runtime}/src/**/*.ts').scan({
    cwd: source,
  }))
    paths.add(path.replaceAll('\\', '/'))
  for (const path of await nativeSourcePaths(source)) paths.add(path)
  return Promise.all(
    [...paths].sort().map(async (path) => ({ path, ...(await digest(join(source, path))) }))
  )
}
