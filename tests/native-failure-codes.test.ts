import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  classifyNativeHostFailure,
  summarizeNativeHostFailures,
} from '../benchmarks/lib/native-failure-codes.ts'

test('native failure diagnostics distinguish known shutdown, owner and protocol failures', () => {
  for (const [message, code] of [
    ['Native shutdown acknowledgement deadline exceeded', 'native-shutdown-deadline'],
    ['Cookie store unavailable during session disposal', 'session-disposal-cookie-store'],
    ['Cookie store flush could not be scheduled', 'session-disposal-cookie-flush'],
    ['CEF command dispatch unavailable', 'cef-command-dispatch-unavailable'],
    ['Renderer process terminated before native shutdown', 'renderer-terminated'],
    ['Native focus could not leave an ineligible pane', 'view-focus-eviction'],
    ['Bun backend process exited before native shutdown', 'backend-supervised-early-exit'],
    ['Bun backend exited before native shutdown', 'backend-pipe-early-exit'],
    ['Bun input closed', 'backend-input-closed'],
    ['Invalid protocol version or request sequence', 'application-protocol-sequence'],
    ['Menu qualification input unavailable', 'menu-input-unavailable'],
    ['Menu input requires the native main thread', 'menu-input-main-thread'],
    ['Menu owner view unavailable', 'menu-owner-view-unavailable'],
    ['Menu owner window unavailable', 'menu-owner-window-unavailable'],
    ['Menu input requires the active visible owner window', 'menu-owner-not-active-visible'],
    ['Menu owner window number unavailable', 'menu-owner-window-number-unavailable'],
    ['Menu input event construction failed', 'menu-input-event-construction'],
    ['Native menu cleanup admission unavailable', 'menu-cleanup-admission'],
    ['Native menu main run loop unavailable', 'menu-main-run-loop-unavailable'],
    ['Native menu common run-loop modes unavailable', 'menu-common-modes-unavailable'],
    ['Native menu cancellation requires the native main thread', 'menu-cancel-main-thread'],
    ['Status item event identity exhausted', 'status-event-identity-exhausted'],
    ['Status item callback count exhausted', 'status-callback-count-exhausted'],
    ['Status item cleanup unavailable', 'status-cleanup-unavailable'],
    ['Status item native removal failed', 'status-native-removal-failed'],
    ['Native status items remain owned at shutdown', 'status-shutdown-ownership'],
  ])
    assert.equal(classifyNativeHostFailure(message), code)
})

test('menu input diagnostics accept only fixed labels and never include native details', () => {
  const privatePayload = '/private/example/menu-owner?secret=fixture-only'
  for (const message of [
    'Menu qualification input unavailable',
    'Menu input requires the native main thread',
    'Menu owner view unavailable',
    'Menu owner window unavailable',
    'Menu input requires the active visible owner window',
    'Menu owner window number unavailable',
    'Menu input event construction failed',
  ]) {
    assert.equal(classifyNativeHostFailure(`${message}: ${privatePayload}`), 'unclassified')
    assert.equal(classifyNativeHostFailure(` ${message}`), 'unclassified')
    assert.equal(classifyNativeHostFailure(`${message}\n`), 'unclassified')
  }
})

test('unknown, decorated and malformed failures never return raw input or match a known prefix', () => {
  const known = 'Native shutdown acknowledgement deadline exceeded'
  const privatePayload = '/private/example/profile?secret=fixture-only'
  for (const value of [
    null,
    undefined,
    {},
    [],
    1,
    'constructor',
    '__proto__',
    '',
    privatePayload,
    `${known} ${privatePayload}`,
    `${known}\n${privatePayload}`,
    ` ${known}`,
    `${known} `,
    known.toLowerCase(),
    known.repeat(1000),
  ])
    assert.equal(classifyNativeHostFailure(value), 'unclassified')
})

test('fresh failure summaries preserve duplicate failures and their observed shutdown order', () => {
  const failure = {
    event: 'bunly.host.failure',
    error: 'Native shutdown acknowledgement deadline exceeded',
    privateDetail: '/private/example/ignored',
  }
  assert.deepEqual(
    summarizeNativeHostFailures([
      { event: 'bunly.workbench.ready', privateDetail: 'ignored' },
      failure,
      failure,
      { event: 'bunly.host.shutdown-phase', phase: 'process-stop', state: 'start' },
      { event: 'bunly.host.failure', error: 'Bun input closed' },
      { event: 'bunly.host.shutdown-phase', phase: 'process-stop', state: 'complete' },
      { event: 'bunly.host.failure' },
      { event: 'bunly.host.shutdown-phase', phase: 'host-release', state: 'start' },
      { event: 'bunly.host.failure', error: 'View overlay unavailable' },
      { event: 'bunly.host.shutdown', clean: false },
    ]),
    [
      { code: 'native-shutdown-deadline', phase: 'no-phase-start-observed' },
      { code: 'native-shutdown-deadline', phase: 'no-phase-start-observed' },
      { code: 'backend-input-closed', phase: 'process-stop' },
      { code: 'unclassified', phase: 'process-stop' },
      { code: 'view-overlay-unavailable', phase: 'host-release' },
    ]
  )
})

test('arbitrary phase names and error payloads cannot escape the finite summary', () => {
  const privatePayload = '/private/example/profile?secret=fixture-only'
  const summary = summarizeNativeHostFailures([
    { event: 'bunly.host.shutdown-phase', phase: privatePayload, state: 'start' },
    { event: 'bunly.host.failure', error: privatePayload, privateDetail: privatePayload },
  ])
  assert.deepEqual(summary, [{ code: 'unclassified', phase: 'unclassified-phase' }])
  assert.equal(JSON.stringify(summary).includes(privatePayload), false)
  assert.throws(
    () =>
      summarizeNativeHostFailures(Array.from({ length: 169 }, () => ({ event: privatePayload }))),
    /^Error: Native failure event budget exceeded$/
  )
})

function pendingSnapshot() {
  return {
    schema: 1,
    stateAvailable: true,
    quitting: true,
    finalizing: false,
    saturated: false,
    credentialRetirementPending: false,
    owners: {
      windows: 0,
      windowsClosing: 0,
      views: 4,
      viewsClosing: 0,
      viewsCreating: 0,
      browserReferences: 4,
      browserViewReferences: 4,
      overlayReferences: 4,
      sessions: 4,
      sessionsBusy: 0,
      sessionsCreating: 0,
      sessionsDisposing: 0,
    },
    callbacks: {
      finalizeSessions: 0,
      finishLoop: 0,
      ioFence: 0,
      uiFence: 0,
      windowDestroyed: 1,
      browserBeforeClose: 0,
      flushRequested: 0,
      flushCompleted: 0,
      connectionsCloseRequested: 0,
      connectionsClosed: 0,
    },
  }
}

test('fresh native deadline snapshots return only fixed bounded counts and booleans', () => {
  const pending = pendingSnapshot()
  const privatePayload = '/private/example/profile?secret=fixture-only'
  const summary = summarizeNativeHostFailures([
    {
      event: 'bunly.host.failure',
      error: 'Native shutdown acknowledgement deadline exceeded',
      pending: {
        ...pending,
        privateDetail: privatePayload,
        owners: { ...pending.owners, privateDetail: privatePayload },
        callbacks: { ...pending.callbacks, privateDetail: privatePayload },
      },
    },
  ])
  assert.deepEqual(summary, [
    {
      code: 'native-shutdown-deadline',
      phase: 'no-phase-start-observed',
      pending: { status: 'observed', ...pending },
    },
  ])
  assert.equal(JSON.stringify(summary).includes(privatePayload), false)
  // These counts are synthetic parser input, not a native workbench result.
  assert.equal(pending.owners.views, 4)
})

test('malformed, unsupported or falsely unsaturated deadline snapshots remain unclassified', () => {
  const valid = pendingSnapshot()
  for (const pending of [
    undefined,
    null,
    [],
    {},
    { ...valid, schema: 2 },
    { ...valid, quitting: 'private text' },
    { ...valid, owners: { ...valid.owners, views: '/private/example' } },
    { ...valid, owners: { ...valid.owners, views: -1 } },
    { ...valid, owners: { ...valid.owners, views: 0.5 } },
    { ...valid, owners: { ...valid.owners, views: Infinity } },
    { ...valid, callbacks: { ...valid.callbacks, flushCompleted: 65_536 } },
    { ...valid, callbacks: { ...valid.callbacks, flushCompleted: 65_535 } },
    { ...valid, saturated: true },
  ]) {
    const summary = summarizeNativeHostFailures([
      {
        event: 'bunly.host.failure',
        error: 'Native shutdown acknowledgement deadline exceeded',
        pending,
      },
    ])
    assert.deepEqual(summary[0]?.pending, { status: 'unclassified' })
  }
  const saturated = {
    ...valid,
    saturated: true,
    callbacks: { ...valid.callbacks, flushCompleted: 65_535 },
  }
  assert.deepEqual(
    summarizeNativeHostFailures([
      {
        event: 'bunly.host.failure',
        error: 'Native shutdown acknowledgement deadline exceeded',
        pending: saturated,
      },
    ])[0]?.pending,
    { status: 'observed', ...saturated }
  )
  assert.deepEqual(
    summarizeNativeHostFailures([
      { event: 'bunly.host.failure', error: 'unknown', pending: valid },
    ]),
    [{ code: 'unclassified', phase: 'no-phase-start-observed' }]
  )
  assert.deepEqual(
    summarizeNativeHostFailures([
      {
        event: 'bunly.host.failure',
        error: 'Native shutdown acknowledgement deadline exceeded',
        pending: { schema: 1, stateAvailable: false, privateDetail: '/private/example' },
      },
    ])[0]?.pending,
    { status: 'state-unavailable' }
  )
})
