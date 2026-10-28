import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  acceptParentClose,
  acceptParentCloseReceipt,
  acceptParentCloseReport,
  PARENT_CLOSE_PROFILE,
  parentCloseRequiredSources,
} from '../benchmarks/desktop/parent-close-acceptance.ts'
import { parentClosePanes } from '../examples/view-parent-close/receipts.ts'
import { desktopProfile, desktopReportProfile } from '../benchmarks/desktop/profiles.ts'
import { desktopReportFixture } from './helpers/desktop-evidence.ts'

/** Synthetic parser input only; never native qualification evidence. */
function receipt() {
  return {
    event: 'bunly.native.view-parent-close',
    schema: 1,
    passed: true,
    before: { windows: 2, views: 4, sessions: 4 },
    controlSurvived: true,
    observations: {
      panes: parentClosePanes.map((pane, index) => ({
        pane,
        viewId: `view-${index}`,
        sessionId: `session-${index}`,
        documentId: `native-${index + 10}-1`,
        nativeTarget: index + 10,
        closed: true,
      })),
      nativeWindowTarget: 1,
      nativeViewCloseCallbacks: 4,
      nativeWindowCloseCallbacks: 1,
    },
    sessionsReleasedAfterNativeClose: 4,
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
    final: { windows: 0, views: 0, sessions: 0, listeners: 0, listenerErrors: 0 },
    failure: null,
    osQuitQualified: false,
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
  }
}

test('parent-close acceptance requires all live panes and matching native callback identities', () => {
  assert.equal(acceptParentCloseReceipt(receipt()).nativeViewCloseCallbacks, 4)
  for (const mutate of [
    (row: ReturnType<typeof receipt>) => {
      row.controlSurvived = false
    },
    (row: ReturnType<typeof receipt>) => {
      row.before.views = 3
    },
    (row: ReturnType<typeof receipt>) => {
      row.observations.panes.pop()
    },
    (row: ReturnType<typeof receipt>) => {
      row.observations.panes[0]!.closed = false
    },
    (row: ReturnType<typeof receipt>) => {
      row.observations.panes[0]!.nativeTarget = 11
    },
    (row: ReturnType<typeof receipt>) => {
      row.observations.panes[0]!.documentId += '\n'
    },
    (row: ReturnType<typeof receipt>) => {
      row.observations.panes[1]!.sessionId = row.observations.panes[0]!.sessionId
    },
    (row: ReturnType<typeof receipt>) => {
      row.observations.nativeWindowTarget = 10
    },
    (row: ReturnType<typeof receipt>) => {
      row.observations.nativeViewCloseCallbacks = 3
    },
    (row: ReturnType<typeof receipt>) => {
      row.observations.nativeWindowCloseCallbacks = 0
    },
    (row: ReturnType<typeof receipt>) => {
      row.sessionsReleasedAfterNativeClose = 3
    },
    (row: ReturnType<typeof receipt>) => {
      row.nativeFinal.views = 1
    },
    (row: ReturnType<typeof receipt>) => {
      row.nativeFinal.sessions = 1
    },
    (row: ReturnType<typeof receipt>) => {
      row.final.listeners = 1
    },
    (row: ReturnType<typeof receipt>) => {
      row.osQuitQualified = true
    },
    (row: ReturnType<typeof receipt>) => {
      row.performanceEligible = true
    },
  ]) {
    const row = receipt()
    mutate(row)
    assert.throws(() => acceptParentCloseReceipt(row))
  }
  assert.throws(() => acceptParentCloseReceipt({ ...receipt(), privatePath: '/unreviewed' }))
})

test('parent-close evidence keeps the full source, artifact and native cleanup contract', () => {
  const row = receipt()
  const report = desktopReportFixture({
    receipt: row,
    acceptance: acceptParentCloseReceipt(row),
    profile: PARENT_CLOSE_PROFILE,
    sourcePaths: parentCloseRequiredSources,
  })
  assert.equal(acceptParentCloseReport(report).livePanesAtParentClose, 4)
  const observation = report['observation'] as Record<string, unknown>
  assert.equal(acceptParentClose(observation).nativeWindowCloseCallbacks, 1)
  const missing = structuredClone(report)
  missing['sourceHashes'] = (missing['sourceHashes'] as { path: string }[]).filter(
    (entry) => entry.path !== 'native/cef-host/src/view_close.rs'
  )
  missing['sourceHashesAfter'] = missing['sourceHashes']
  assert.throws(() => acceptParentCloseReport(missing))
  assert.throws(() =>
    acceptParentClose({ ...observation, cleanupSurvivors: [{ pid: 1, createTime: 1 }] })
  )
  assert.throws(() => acceptParentClose({ ...observation, stderr: [] }))
})

test('parent close is a separate declared profile and diagnostic receipt', () => {
  const profile = desktopProfile('parent-close')
  assert.equal(profile.profile, PARENT_CLOSE_PROFILE)
  assert.equal(profile.fixture, 'examples/view-parent-close')
  assert.equal(desktopReportProfile(PARENT_CLOSE_PROFILE), profile)
  assert.equal(desktopProfile('composition').profile, 'native-view-composition-v1')
  assert.ok(profile.sourceSelectors.includes('examples/view-parent-close'))
  const events = JSON.parse(
    readFileSync(
      new URL('../benchmarks/lib/native-diagnostic-events.json', import.meta.url),
      'utf8'
    )
  ) as string[]
  assert.equal(events.filter((event) => event === 'bunly.native.view-parent-close').length, 1)
})
