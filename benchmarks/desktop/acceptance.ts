import assert from 'node:assert/strict'
import { parseCefWindowState } from '../../packages/runtime/src/cef-window-state.ts'
import { nativeEvents } from '../lib/cef-acceptance.ts'
import { assertCleanCommand, validateCommandObservation } from '../lib/observed-command.ts'
import { observeNativeShutdown, requireNativeShutdown } from '../foundation/native-shutdown.ts'
import { acceptPreparedFileMetadata } from '../reload/prepared-file-metadata.ts'
import { cefIdentityFromObservation } from '../lib/cef-identity.ts'
import type { InventoryEntry } from '../lib/inventory.ts'

export const DESKTOP_PROFILE = 'native-desktop-controls-v1'
export const DESKTOP_OBSERVER_MS = 45_000
export const desktopSourceSelectors = [
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'tsconfig.browser.json',
  'packages/contracts/src',
  'packages/client/src',
  'packages/runtime/src',
  'packages/cli/src',
  'examples/desktop-controls',
  'benchmarks/desktop',
  'benchmarks/reload',
  'benchmarks/lib',
  'benchmarks/foundation',
  'scripts',
  'native/cef-host',
] as const
export const desktopControlSteps = [
  'initial',
  'geometry',
  'resize',
  'hidden',
  'shown',
  'minimized',
  'restored',
  'maximized',
  'unmaximized',
  'fullscreen',
  'windowed',
  'activation-request',
  'after-unsubscribe',
] as const

function record(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Expected record')
  return input as Record<string, unknown>
}
function checksum(input: unknown, length = 64): asserts input is string {
  assert.ok(typeof input === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(input))
}
function memberPath(input: unknown): asserts input is string {
  assert.ok(
    typeof input === 'string' &&
      input.length > 0 &&
      input.length <= 4096 &&
      !input.includes('\\') &&
      !input.includes('\0') &&
      !input.includes(':') &&
      !input.split('/').some((part) => !part || part === '.' || part === '..'),
    'Invalid relative inventory path'
  )
}
function artifact(input: unknown): readonly InventoryEntry[] {
  const value = record(input)
  assert.equal(value['schema'], 1)
  assert.equal(value['metric'], 'logical-installed-file-bytes-no-symlink-traversal')
  const entries = value['entries']
  assert.ok(Array.isArray(entries) && entries.length > 5 && entries.length < 16384)
  let bytes = 0
  const paths = new Set<string>()
  const groups = new Map<string, { paths: string[]; bytesPerCopy: number }>()
  for (const item of entries) {
    const entry = record(item)
    memberPath(entry['path'])
    assert.ok(!paths.has(entry['path']), 'Duplicate inventory member')
    paths.add(entry['path'])
    assert.ok(
      Number.isSafeInteger(entry['bytes']) &&
        Number(entry['bytes']) >= 0 &&
        Number(entry['bytes']) <= 2 ** 40
    )
    bytes += Number(entry['bytes'])
    if (entry['kind'] === 'file') {
      assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'kind', 'path', 'sha256'])
      checksum(entry['sha256'])
      const group = groups.get(entry['sha256'])
      if (group) {
        assert.equal(entry['bytes'], group.bytesPerCopy)
        group.paths.push(entry['path'])
      } else
        groups.set(entry['sha256'], {
          paths: [entry['path']],
          bytesPerCopy: Number(entry['bytes']),
        })
    } else {
      assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'kind', 'path', 'sha256', 'target'])
      assert.equal(entry['kind'], 'symlink')
      assert.equal(entry['sha256'], null)
      assert.equal(entry['bytes'], 0)
      assert.ok(
        typeof entry['target'] === 'string' &&
          entry['target'].length > 0 &&
          entry['target'].length <= 4096 &&
          !entry['target'].includes('\0')
      )
    }
  }
  assert.ok(Number.isSafeInteger(bytes))
  assert.equal(value['bytes'], bytes)
  assert.deepEqual(
    value['duplicateContent'],
    [...groups.values()].filter((group) => group.paths.length > 1)
  )
  return entries as InventoryEntry[]
}
function file(
  entries: readonly InventoryEntry[],
  path: string
): InventoryEntry & { sha256: string } {
  const entry = entries.find((entry) => entry.path === path)
  assert.ok(entry && entry.kind === 'file' && entry.bytes > 0)
  checksum(entry.sha256)
  return entry as InventoryEntry & { sha256: string }
}
function observedPlatform(input: unknown, target: string, timeout: number) {
  const observation = validateCommandObservation(input)
  assertCleanCommand(observation)
  // This is the existing observer's entire outer guard, including bounded
  // post-exit accounting. Its launch timeout and native deadlines are unchanged.
  assert.ok(
    observation.elapsedMs <= timeout + 15_000,
    'Observer exceeded its full lifecycle envelope'
  )
  const os = target === 'darwin-arm64' ? 'Darwin' : target === 'win32-x64' ? 'Windows' : 'Linux'
  assert.equal(observation.environment['os'], os, 'Observer OS does not match the target')
  const arch = observation.environment['arch']
  assert.ok(
    (target === 'darwin-arm64' ? ['arm64', 'aarch64'] : ['x86_64', 'AMD64', 'amd64']).includes(
      String(arch)
    )
  )
  assert.ok(['local-smoke', 'ci-smoke'].includes(String(observation.environment['runClass'])))
  return observation
}
function bounds(input: unknown) {
  const row = record(input)
  assert.deepEqual(Object.keys(row).sort(), ['height', 'width', 'x', 'y'])
  for (const key of ['x', 'y', 'width', 'height'])
    assert.ok(Number.isSafeInteger(row[key]) && Math.abs(Number(row[key])) <= 32768)
  assert.ok(Number(row['width']) >= 0 && Number(row['height']) >= 0)
  return {
    x: Number(row['x']),
    y: Number(row['y']),
    width: Number(row['width']),
    height: Number(row['height']),
  }
}

export function acceptDesktopControlReceipt(input: unknown) {
  const receipt = record(input)
  assert.equal(receipt['event'], 'bunly.native.desktop-controls')
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['passed'], true)
  assert.equal(receipt['failure'], null)
  assert.equal(receipt['physicalInputQualified'], false)
  assert.equal(receipt['hardwareDpiQualified'], false)
  assert.equal(receipt['performanceEligible'], false)
  const steps = receipt['steps']
  assert.ok(Array.isArray(steps))
  assert.deepEqual(
    steps.map((step: unknown) => record(step)['name']),
    desktopControlSteps
  )
  for (const value of steps) {
    const row = record(value)
    assert.deepEqual(Object.keys(row).sort(), ['bounds', 'name', 'state'])
    const state = parseCefWindowState(row['state'])
    const geometry = bounds(row['bounds'])
    const name = row['name']
    assert.equal(state.minimized, name === 'minimized')
    // Some window managers expose maximized and fullscreen as independent flags.
    if (name !== 'fullscreen') assert.equal(state.maximized, name === 'maximized')
    assert.equal(state.fullscreen, name === 'fullscreen')
    if (name !== 'minimized') assert.equal(state.visible, name !== 'hidden')
    if (name !== 'minimized') assert.ok(geometry.width > 0 && geometry.height > 0)
    if (name === 'geometry') assert.deepEqual(geometry, { x: 64, y: 64, width: 704, height: 464 })
    if (name === 'resize') {
      assert.equal(geometry.width, 736)
      assert.equal(geometry.height, 496)
    }
    if (name === 'after-unsubscribe') {
      assert.equal(geometry.width, 704)
      assert.equal(geometry.height, 464)
    }
  }
  const page = record(receipt['page'])
  assert.deepEqual(Object.keys(page).sort(), ['devicePixelRatio', 'height', 'instance', 'width'])
  assert.ok(typeof page['instance'] === 'string' && /^[a-f0-9-]{36}$/.test(page['instance']))
  for (const key of ['width', 'height'])
    assert.ok(
      Number.isSafeInteger(page[key]) && Number(page[key]) > 0 && Number(page[key]) <= 32768
    )
  assert.ok(
    typeof page['devicePixelRatio'] === 'number' &&
      Number.isFinite(page['devicePixelRatio']) &&
      page['devicePixelRatio'] > 0 &&
      page['devicePixelRatio'] <= 16
  )
  assert.deepEqual(
    receipt['pageVisibility'],
    ['visible', 'hidden', 'visible', 'hidden', 'visible'].map((visibility, sequence) => ({
      sequence,
      visibility,
    })),
    'Independent hide/show/minimize/restore page visibility is required'
  )
  const events = record(receipt['events'])
  assert.ok(
    Number.isSafeInteger(events['count']) &&
      Number(events['count']) >= 3 &&
      Number(events['count']) <= 256
  )
  assert.ok(Array.isArray(events['last']) && events['last'].length <= 16)
  assert.equal(events['closed'], 1)
  assert.equal(events['afterAbort'], 0)
  for (const key of ['state', 'bounds'])
    assert.ok(
      Number.isSafeInteger(events[key]) && Number(events[key]) > 0 && Number(events[key]) <= 256,
      `Missing native ${key} notification`
    )
  assert.ok(
    Array.isArray(events['fullscreen']) &&
      events['fullscreen'].length >= 2 &&
      events['fullscreen'].length <= 8
  )
  const completed: boolean[] = []
  for (const item of events['fullscreen']) {
    const transition = record(item)
    assert.deepEqual(Object.keys(transition).sort(), ['completed', 'state'])
    assert.equal(typeof transition['completed'], 'boolean')
    const state = parseCefWindowState(transition['state'])
    if (transition['completed']) completed.push(state.fullscreen)
  }
  assert.deepEqual(completed, [true, false], 'Both native fullscreen transitions must complete')
  assert.equal(
    events['count'],
    Number(events['state']) + Number(events['bounds']) + events['fullscreen'].length + 1
  )
  assert.equal(receipt['invalidRejected'], true)
  assert.equal(receipt['staleRejected'], true)
  assert.deepEqual(receipt['nativeFinal'], {
    windows: 1,
    views: 0,
    sessions: 0,
    pending: 0,
    nativeDeliveryPackets: 0,
    nativeDeliveryBytes: 0,
    rpcIncomingBytes: 0,
    streamIncomingBytes: 0,
  })
  return Object.freeze({
    steps: desktopControlSteps.length,
    fullscreenTransitions: completed.length,
    closedEvents: 1,
    abortedDeliveries: 0,
    devicePixelRatio: page['devicePixelRatio'],
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    performanceEligible: false,
  })
}

export function acceptDesktopControls(input: unknown) {
  return acceptDesktopObservation(
    input,
    'bunly.native.desktop-controls',
    acceptDesktopControlReceipt
  )
}

/** Shared process/shutdown checks; each workload still validates its exact receipt. */
export function acceptDesktopObservation<T>(
  input: unknown,
  eventName: string,
  acceptReceipt: (receipt: unknown) => T
): T {
  const observation = validateCommandObservation(input)
  assertCleanCommand(observation)
  requireNativeShutdown(observeNativeShutdown(observation))
  const events = nativeEvents(observation)
  const results = events.filter((event) => event['event'] === eventName)
  assert.equal(results.length, 1, `Missing or duplicate ${eventName} receipt`)
  assert.deepEqual(
    events.filter((event) => event['event'] === 'bunly.native.output-drained'),
    [
      {
        event: 'bunly.native.output-drained',
        schema: 1,
        frames: 0,
        ordinaryFrames: 0,
        retainedWireBytes: 0,
        ordinaryWireBytes: 0,
      },
    ]
  )
  return acceptReceipt(results[0])
}

export function acceptDesktopReport(input: unknown) {
  return acceptDesktopEvidence(input, DESKTOP_PROFILE, [], acceptDesktopControls)
}

/** Preserve one source/artifact/observer contract for all native desktop cases. */
export function acceptDesktopEvidence<T>(
  input: unknown,
  profile: string,
  requiredSources: readonly string[],
  acceptObservation: (observation: unknown) => T
): T {
  const report = record(input)
  assert.equal(report['schema'], 1)
  assert.equal(report['profile'], profile)
  assert.equal(report['passed'], true)
  assert.equal(report['bun'], '1.4.3')
  assert.equal(report['observerTimeoutMs'], DESKTOP_OBSERVER_MS)
  assert.equal(report['performanceEligible'], false)
  assert.ok(['darwin-arm64', 'linux-x64', 'win32-x64'].includes(String(report['target'])))
  const before = record(report['sourceBefore'])
  assert.equal(before['clean'], true)
  assert.equal(before['reason'], 'clean-checkout')
  assert.ok(typeof before['commit'] === 'string' && /^[a-f0-9]{40}$/.test(before['commit']))
  assert.deepEqual(report['sourceAfter'], before)
  const hashes = report['sourceHashes']
  assert.ok(Array.isArray(hashes) && hashes.length > 10 && hashes.length <= 4096)
  const sourcePaths = new Set<string>()
  for (const input of hashes) {
    const entry = record(input)
    assert.deepEqual(Object.keys(entry).sort(), ['path', 'sha256'])
    memberPath(entry['path'])
    checksum(entry['sha256'])
    assert.ok(!sourcePaths.has(entry['path']), 'Duplicate source fingerprint')
    sourcePaths.add(entry['path'])
  }
  for (const required of [
    'package.json',
    'bun.lock',
    'tsconfig.json',
    'tsconfig.browser.json',
    'packages/contracts/src/windows.ts',
    'packages/runtime/src/cef.ts',
    'packages/runtime/src/native-transport.ts',
    'examples/desktop-controls/fixture.ts',
    'examples/desktop-controls/client.ts',
    'examples/desktop-controls/contract.ts',
    'benchmarks/desktop/acceptance.ts',
    'benchmarks/reload/prepared-file-metadata.ts',
    'benchmarks/lib/observed-command.ts',
    'benchmarks/lib/cef-identity.ts',
    'benchmarks/lib/inventory.ts',
    'scripts/qualify-desktop.ts',
    'scripts/observe-process.py',
    'native/cef-host/src/window_state.rs',
    'native/cef-host/src/process.rs',
    'native/cef-host/src/host.rs',
    ...requiredSources,
  ])
    assert.ok(sourcePaths.has(required), `Missing source fingerprint: ${required}`)
  assert.deepEqual(report['sourceHashesAfter'], hashes)
  const native = record(report['nativeSource'])
  checksum(native['declaredCommit'], 40)
  checksum(native['tree'], 40)
  assert.equal(native['embeddedBuildAttestation'], false)
  assert.equal(report['inputArtifactUnchanged'], true)
  assert.equal(report['preparedArtifactUnchanged'], true)
  const selected = artifact(report['inputArtifact'])
  const prepared = artifact(report['preparedArtifact'])
  assert.deepEqual(report['inputArtifactAfter'], report['inputArtifact'])
  assert.deepEqual(report['preparedArtifactAfter'], report['preparedArtifact'])
  const target = String(report['target'])
  const mac = target === 'darwin-arm64'
  const windows = target === 'win32-x64'
  const hostPath = mac ? 'Contents/MacOS/bunly_host' : windows ? 'bunly_host.exe' : 'bunly_host'
  assert.equal(report['hostPath'], hostPath)
  assert.equal(report['inputHostSha256'], file(selected, hostPath).sha256)
  assert.equal(report['preparedHostSha256'], file(prepared, hostPath).sha256)
  const library = file(
    prepared,
    mac
      ? 'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
      : windows
        ? 'libcef.dll'
        : 'libcef.so'
  )
  const identity = cefIdentityFromObservation(
    observedPlatform(report['identityObservation'], target, 30_000),
    library.sha256
  )
  assert.equal(identity.cefVersion, '156.0.7')
  assert.equal(identity.chromiumVersion, '156.0.8078.17')
  assert.deepEqual(report['runtimeIdentity'], identity)
  const bun = record(report['bundledBun'])
  const bunPath = mac ? 'Contents/Resources/bun' : windows ? 'resources/bun.exe' : 'resources/bun'
  assert.equal(bun['path'], bunPath)
  assert.equal(bun['sha256'], file(prepared, bunPath).sha256)
  assert.equal(bun['version'], '1.4.3')
  assert.deepEqual(observedPlatform(bun['observation'], target, 30_000).stdoutTail, ['1.4.3'])
  const observation = observedPlatform(report['observation'], target, DESKTOP_OBSERVER_MS)
  if (mac) {
    assert.equal(
      observation.postExitCleanup?.qualified,
      true,
      'Positive macOS helper cleanup is required'
    )
    assert.equal(observation.postExitCleanup?.status, 'completed')
  }
  const files = report['preparedMetadataBefore']
  assert.ok(
    Array.isArray(files) && files.length === prepared.length,
    'Incomplete prepared metadata'
  )
  assert.deepEqual(
    files.map((entry) => record(entry)['path']),
    prepared.map((entry) => entry.path)
  )
  for (const [index, entry] of prepared.entries())
    if (entry.kind === 'file') assert.equal(record(files[index])['size'], String(entry.bytes))
  const metadata = acceptPreparedFileMetadata({
    before: report['preparedMetadataBefore'],
    after: report['preparedMetadataAfter'],
    target: String(report['target']),
    hostPath: String(report['hostPath']),
    observations: [observation],
  })
  assert.deepEqual(report['preparedMetadata'], metadata)
  const result = acceptObservation(observation)
  assert.deepEqual(report['acceptance'], result)
  return result
}
