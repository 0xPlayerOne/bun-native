import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { desktopReportFixture } from './helpers/desktop-evidence.ts'
import {
  acceptDesktopControlReceipt,
  acceptDesktopReport,
  DESKTOP_OBSERVER_MS,
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

function reportFixture(target = 'linux-x64'): Record<string, unknown> {
  return desktopReportFixture({
    receipt: receipt(),
    acceptance: acceptDesktopControlReceipt(receipt()),
    target,
  })
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
