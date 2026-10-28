import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  acceptDesktopControlReceipt,
  acceptDesktopReport,
  DESKTOP_OBSERVER_MS,
  DESKTOP_PROFILE,
  desktopControlSteps,
} from '../benchmarks/desktop/acceptance.ts'

function receipt() {
  const normal = {
    visible: true,
    active: false,
    minimized: false,
    maximized: false,
    fullscreen: false,
  }
  const geometry = { x: 64, y: 64, width: 704, height: 464 }
  return {
    event: 'bunly.native.desktop-controls',
    schema: 1,
    passed: true,
    failure: null,
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    performanceEligible: false,
    steps: desktopControlSteps.map((name) => ({
      name,
      state: {
        ...normal,
        visible: name !== 'hidden',
        minimized: name === 'minimized',
        maximized: name === 'maximized',
        fullscreen: name === 'fullscreen',
      },
      bounds: { ...geometry, ...(name === 'resize' ? { width: 736, height: 496 } : {}) },
    })),
    page: {
      instance: '12345678-1234-1234-1234-123456789abc',
      width: 640,
      height: 400,
      devicePixelRatio: 1,
    },
    pageVisibility: ['visible', 'hidden', 'visible', 'hidden', 'visible'].map(
      (visibility, sequence) => ({ sequence, visibility })
    ),
    events: {
      count: 25,
      state: 10,
      bounds: 10,
      last: [],
      closed: 1,
      afterAbort: 0,
      fullscreen: [
        { completed: false, state: { ...normal, fullscreen: true } },
        { completed: true, state: { ...normal, fullscreen: true } },
        { completed: false, state: normal },
        { completed: true, state: normal },
      ],
    },
    invalidRejected: true,
    staleRejected: true,
    nativeFinal: {
      windows: 1,
      views: 0,
      sessions: 0,
      pending: 0,
      nativeDeliveryPackets: 0,
      nativeDeliveryBytes: 0,
      rpcIncomingBytes: 0,
      streamIncomingBytes: 0,
    },
  }
}

test('desktop acceptance requires the complete real-state sequence without inventing activation', () => {
  const value = receipt()
  const result = acceptDesktopControlReceipt(value)
  assert.equal(result.steps, 13)
  assert.equal(result.fullscreenTransitions, 2)
  assert.equal(result.performanceEligible, false)
  assert.equal(value.steps.find((step) => step.name === 'activation-request')!.state.active, false)
})

test('desktop acceptance rejects lost steps, intent-only fullscreen and duplicate completion', () => {
  const missing = receipt()
  missing.steps.splice(2, 1)
  assert.throws(() => acceptDesktopControlReceipt(missing))
  const intent = receipt()
  intent.events.fullscreen.forEach((event) => {
    event.completed = false
  })
  assert.throws(() => acceptDesktopControlReceipt(intent))
  const duplicate = receipt()
  duplicate.events.fullscreen.push(duplicate.events.fullscreen.at(-1)!)
  assert.throws(() => acceptDesktopControlReceipt(duplicate))
  const reordered = receipt()
  reordered.steps.reverse()
  assert.throws(() => acceptDesktopControlReceipt(reordered))
})

test('desktop acceptance rejects stale geometry, invisible state and fabricated window values', () => {
  for (const mutate of [
    (value: ReturnType<typeof receipt>) => {
      value.steps[1]!.bounds.x = 48
    },
    (value: ReturnType<typeof receipt>) => {
      value.steps[2]!.bounds.width = 640
    },
    (value: ReturnType<typeof receipt>) => {
      value.steps[4]!.state.visible = false
    },
    (value: ReturnType<typeof receipt>) => {
      value.steps[8]!.state.maximized = true
    },
    (value: ReturnType<typeof receipt>) => {
      value.steps[10]!.state.fullscreen = true
    },
    (value: ReturnType<typeof receipt>) => {
      value.steps[0]!.bounds.height = Number.NaN
    },
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptDesktopControlReceipt(value))
  }
})

test('desktop acceptance rejects retained resources, callbacks after abort and missing revocation', () => {
  for (const mutate of [
    (value: ReturnType<typeof receipt>) => {
      value.nativeFinal.views = 1
    },
    (value: ReturnType<typeof receipt>) => {
      value.nativeFinal.pending = 1
    },
    (value: ReturnType<typeof receipt>) => {
      value.nativeFinal.nativeDeliveryBytes = 1
    },
    (value: ReturnType<typeof receipt>) => {
      value.events.afterAbort = 1
    },
    (value: ReturnType<typeof receipt>) => {
      value.events.closed = 2
    },
    (value: ReturnType<typeof receipt>) => {
      value.events.count = 257
    },
    (value: ReturnType<typeof receipt>) => {
      value.staleRejected = false
    },
    (value: ReturnType<typeof receipt>) => {
      value.invalidRejected = false
    },
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptDesktopControlReceipt(value))
  }
})

test('desktop functional evidence does not establish hardware input, display or performance support', () => {
  for (const key of [
    'physicalInputQualified',
    'hardwareDpiQualified',
    'performanceEligible',
  ] as const) {
    const value = receipt()
    value[key] = true
    assert.throws(() => acceptDesktopControlReceipt(value))
  }
  const badPage = receipt()
  badPage.page.devicePixelRatio = Number.POSITIVE_INFINITY
  assert.throws(() => acceptDesktopControlReceipt(badPage))
})

test('desktop acceptance requires state and bounds notifications, beyond readback', () => {
  for (const key of ['state', 'bounds'] as const) {
    const value = receipt()
    value.events[key] = 0
    assert.throws(() => acceptDesktopControlReceipt(value))
  }
})

test('desktop acceptance requires independent ordered page visibility, not native intent', () => {
  const missing = receipt()
  missing.pageVisibility.pop()
  assert.throws(() => acceptDesktopControlReceipt(missing))
  const reordered = receipt()
  reordered.pageVisibility[3]!.visibility = 'visible'
  assert.throws(() => acceptDesktopControlReceipt(reordered))
  const duplicate = receipt()
  duplicate.pageVisibility[4]!.sequence = 3
  assert.throws(() => acceptDesktopControlReceipt(duplicate))
})

/** Synthetic parser inputs only; never exported as native qualification evidence. */
function reportFixture(target = 'linux-x64'): Record<string, unknown> {
  const mac = target === 'darwin-arm64'
  const hostPath = mac ? 'Contents/MacOS/bunly_host' : 'bunly_host'
  const libraryPath = mac
    ? 'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
    : 'libcef.so'
  const resources = mac ? 'Contents/Resources' : 'resources'
  const bunPath = resources + '/bun'
  const entries = [
    hostPath,
    libraryPath,
    bunPath,
    resources + '/runtime.json',
    resources + '/backend/main.js',
    resources + '/backend/application.js',
    resources + '/public/client.js',
  ].map((path, i) => ({ path, kind: 'file', bytes: i + 1, sha256: String(i).repeat(64) }))
  const artifact = {
    schema: 1,
    metric: 'logical-installed-file-bytes-no-symlink-traversal',
    bytes: entries.reduce((sum, item) => sum + item.bytes, 0),
    entries,
    duplicateContent: [],
  }
  const metadata = entries.map((entry, i) => ({
    path: entry.path,
    size: String(entry.bytes),
    mtimeNs: '100',
    ctimeNs: '100',
    device: '1',
    inode: String(i + 1),
    mode: '33216',
    uid: '1000',
    gid: '1000',
    links: '1',
  }))
  const observation = {
    schema: 1,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    cleanupSurvivors: [],
    outputOverflow: false,
    observedOrphans: [],
    elapsedMs: 1000,
    peakTreeRssBytes: 1,
    peakTreeThreads: 1,
    stdoutTail: [] as string[],
    samples: [],
    environment: {
      os: mac ? 'Darwin' : 'Linux',
      arch: mac ? 'arm64' : 'x86_64',
      runClass: 'local-smoke',
    },
    stderr: [
      JSON.stringify(receipt()),
      JSON.stringify({ event: 'bunly.host.shutdown-phase', phase: 'process-stop', state: 'start' }),
      JSON.stringify({ event: 'bunly.backend.exit', code: 0, forced: false }),
      JSON.stringify({
        event: 'bunly.native.output-drained',
        schema: 1,
        frames: 0,
        ordinaryFrames: 0,
        retainedWireBytes: 0,
        ordinaryWireBytes: 0,
      }),
      JSON.stringify({
        event: 'bunly.host.shutdown-phase',
        phase: 'process-stop',
        state: 'complete',
        durationMs: 1,
      }),
      ...['host-release', 'asset-service-stop', 'cef-shutdown'].flatMap((phase) => [
        JSON.stringify({ event: 'bunly.host.shutdown-phase', phase, state: 'start' }),
        JSON.stringify({
          event: 'bunly.host.shutdown-phase',
          phase,
          state: 'complete',
          durationMs: 1,
        }),
      ]),
      JSON.stringify({ event: 'bunly.host.shutdown', clean: true }),
    ],
  }
  const source = { clean: true, reason: 'clean-checkout', commit: 'a'.repeat(40) }
  const hashes = [
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
  ].map((path) => ({ path, sha256: 'b'.repeat(64) }))
  const identity = {
    event: 'cef-binary-identity',
    schema: 1,
    source: 'exported-api',
    sandbox: 'unverified',
    cefVersion: '156.0.7',
    chromiumVersion: '156.0.8078.17',
    cefCommitNumber: 1,
    fullVersion: null,
    sha256: entries[1]!.sha256,
  }
  return {
    schema: 1,
    profile: DESKTOP_PROFILE,
    passed: true,
    performanceEligible: false,
    target,
    bun: '1.4.3',
    observerTimeoutMs: DESKTOP_OBSERVER_MS,
    sourceBefore: source,
    sourceAfter: structuredClone(source),
    sourceHashes: hashes,
    sourceHashesAfter: structuredClone(hashes),
    nativeSource: {
      declaredCommit: source.commit,
      tree: 'c'.repeat(40),
      embeddedBuildAttestation: false,
    },
    inputArtifact: artifact,
    inputArtifactAfter: structuredClone(artifact),
    preparedArtifact: structuredClone(artifact),
    preparedArtifactAfter: structuredClone(artifact),
    inputArtifactUnchanged: true,
    preparedArtifactUnchanged: true,
    hostPath,
    inputHostSha256: entries[0]!.sha256,
    preparedHostSha256: entries[0]!.sha256,
    preparedMetadataBefore: metadata,
    preparedMetadataAfter: structuredClone(metadata),
    preparedMetadata: { identityUnchanged: true, ctimeChangedPaths: [], ctimeChangeReason: 'none' },
    runtimeIdentity: identity,
    identityObservation: { ...observation, stdoutTail: [JSON.stringify(identity)], stderr: [] },
    bundledBun: {
      version: '1.4.3',
      path: bunPath,
      sha256: entries[2]!.sha256,
      observation: { ...observation, stdoutTail: ['1.4.3'], stderr: [] },
    },
    observation,
    acceptance: acceptDesktopControlReceipt(receipt()),
  }
}

test('desktop report requires source, native, Bun and inventory provenance', () => {
  acceptDesktopReport(reportFixture())
  for (const keys of [
    ['inputArtifact', 'inputArtifactAfter'],
    ['preparedArtifact', 'preparedArtifactAfter'],
    ['sourceHashes', 'sourceHashesAfter'],
    ['nativeSource'],
    ['bun'],
  ]) {
    const value = reportFixture()
    for (const key of keys) delete value[key]
    assert.throws(() => acceptDesktopReport(value), keys.join(','))
  }
  for (const key of ['sha256', 'schema']) {
    const value = reportFixture()
    delete (value['runtimeIdentity'] as Record<string, unknown>)[key]
    assert.throws(() => acceptDesktopReport(value))
  }
})

test('desktop report binds every prepared file and executable identity', () => {
  for (const mutate of [
    (r: Record<string, unknown>) => {
      ;(r['preparedMetadataBefore'] as unknown[]).pop()
      ;(r['preparedMetadataAfter'] as unknown[]).pop()
    },
    (r: Record<string, unknown>) => {
      ;(r['runtimeIdentity'] as Record<string, unknown>)['sha256'] = 'f'.repeat(64)
    },
    (r: Record<string, unknown>) => {
      r['inputHostSha256'] = 'f'.repeat(64)
    },
    (r: Record<string, unknown>) => {
      ;(r['bundledBun'] as Record<string, unknown>)['sha256'] = 'f'.repeat(64)
    },
    (r: Record<string, unknown>) => {
      r['sourceHashes'] = []
      r['sourceHashesAfter'] = []
    },
  ]) {
    const value = reportFixture()
    mutate(value)
    assert.throws(() => acceptDesktopReport(value))
  }
})

test('desktop report rejects a different OS, missing Mac cleanup and extended observer budgets', () => {
  const mismatch = reportFixture()
  mismatch['target'] = 'darwin-arm64'
  assert.throws(() => acceptDesktopReport(mismatch))
  assert.throws(() => acceptDesktopReport(reportFixture('darwin-arm64')))
  for (const value of [undefined, DESKTOP_OBSERVER_MS + 1]) {
    const report = reportFixture()
    report['observerTimeoutMs'] = value
    assert.throws(() => acceptDesktopReport(report))
  }
  const slow = reportFixture()
  ;(slow['observation'] as Record<string, unknown>)['elapsedMs'] = 1_000_000
  assert.throws(() => acceptDesktopReport(slow))
})
