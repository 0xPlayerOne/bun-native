import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  classifyDesktopFixtureFailure,
  formatDesktopFixtureFailure,
  summarizeDesktopFailures,
} from '../benchmarks/desktop/failure-codes.ts'
import type { CommandObservation } from '../benchmarks/lib/observed-command.ts'

function observed(events: readonly Record<string, unknown>[]): CommandObservation {
  return {
    exitCode: 1,
    timedOut: false,
    cancelled: false,
    cleanupSurvivors: [],
    outputOverflow: false,
    observedOrphans: [],
    elapsedMs: 1,
    peakTreeRssBytes: 0,
    peakTreeThreads: 0,
    stdoutTail: events.map((value) => JSON.stringify(value)),
    stderr: [],
    nativeDiagnostics: [],
    samples: [],
    environment: {},
  }
}
const unknown = {
  phase: 'unknown-phase',
  name: 'unclassified',
  code: null,
  category: 'unclassified',
}

test('desktop summaries recognize only fixed fixture labels, including current download literals', () => {
  assert.deepEqual(
    classifyDesktopFixtureFailure('downloads', 'complete: Error [windows-root-shared-writer]'),
    { phase: 'complete', name: 'Error', code: null, category: 'windows-root-shared-writer' }
  )
  assert.deepEqual(classifyDesktopFixtureFailure('commands', 'shortcut'), {
    ...unknown,
    phase: 'shortcut',
  })
  assert.deepEqual(
    classifyDesktopFixtureFailure('dialogs', 'open-cancel: Error [workload-deadline]'),
    {
      phase: 'open-cancel',
      name: 'Error',
      code: null,
      category: 'workload-deadline',
    }
  )
  assert.deepEqual(
    classifyDesktopFixtureFailure('downloads', 'network-interruption: Error [native-transition]'),
    {
      phase: 'network-interruption',
      name: 'Error',
      code: null,
      category: 'native-transition',
    }
  )
  assert.deepEqual(
    classifyDesktopFixtureFailure(
      'downloads',
      'native-shutdown: AssertionError (ERR_ASSERTION) [unclassified]'
    ),
    {
      phase: 'native-shutdown',
      name: 'AssertionError',
      code: 'ERR_ASSERTION',
      category: 'unclassified',
    }
  )
  assert.deepEqual(classifyDesktopFixtureFailure('downloads', 'network-interruption: Error'), {
    phase: 'network-interruption',
    name: 'Error',
    code: null,
    category: 'unclassified',
  })
})

test('fixture label parsing cannot export paths, messages, unknown fields or known-label prefixes', () => {
  const known = 'shortcut: Error [observation-order]'
  for (const input of [
    null,
    undefined,
    {},
    [],
    1,
    '',
    'constructor',
    '__proto__',
    '/private/example/path',
    'https://private.invalid/?secret=fixture',
    known + ' /private/example/path',
    known + '\n/private/example/path',
    known + '\n',
    known + '\r',
    known + '\r\n',
    known + '\u2028',
    known + '\u2029',
    ' ' + known,
    known + ' ',
    known.repeat(1000),
    'shortcut: PrivateName [observation-order]',
    'shortcut: Error (PRIVATE_CODE) [observation-order]',
    'shortcut: Error [private-category]',
    'private-phase: Error [observation-order]',
    'open-cancel: Error [workload-deadline]',
  ])
    assert.deepEqual(classifyDesktopFixtureFailure('commands', input), unknown)
})

test('fixture formatting uses exact source categories and suppresses arbitrary error metadata', () => {
  assert.equal(
    formatDesktopFixtureFailure(
      'commands',
      'selected-menu',
      new Error('Unexpected native window command observation order')
    ),
    'selected-menu: Error [observation-order]'
  )
  assert.equal(
    formatDesktopFixtureFailure(
      'dialogs',
      'open-cancel',
      new Error('File dialog fixture deadline')
    ),
    'open-cancel: Error [workload-deadline]'
  )
  assert.equal(
    formatDesktopFixtureFailure('commands', 'policy', {
      name: 'BunlyError',
      code: 'PERMISSION_DENIED',
      message: '/private/fixture',
      stack: '/private/stack',
    }),
    'policy: BunlyError (PERMISSION_DENIED) [unclassified]'
  )
  for (const message of [
    'Unexpected native window command observation order /private/fixture',
    'File dialog fixture deadline\n/private/fixture',
    'https://private.invalid/?secret=fixture',
    'x'.repeat(1_000_000),
  ]) {
    assert.equal(
      formatDesktopFixtureFailure('dialogs', '/private/phase', {
        name: 'PrivateName',
        code: 'PRIVATE_CODE',
        message,
        cause: { message: '/private/cause' },
      }),
      'unknown-phase: Error [unclassified]'
    )
  }
})

test('fresh summaries preserve duplicate failure evidence without returning whole events', () => {
  const privateValue = '/private/example/profile?secret=fixture-only'
  const fixture = {
    event: 'bunly.native.window-commands',
    passed: false,
    failure: 'shortcut: Error [activation-deadline]',
    nativeFinal: privateValue,
    observations: [{ payload: privateValue }],
  }
  const summary = summarizeDesktopFailures(
    'native-window-commands-v1',
    observed([
      {
        event: 'bunly.host.failure',
        error: 'Native shutdown acknowledgement deadline exceeded',
        privateValue,
      },
      fixture,
      fixture,
      { event: 'bunly.host.shutdown-phase', phase: 'process-stop', state: 'start', privateValue },
      { event: 'bunly.host.failure', error: privateValue },
      { event: 'bunly.native.file-dialogs', passed: false, failure: privateValue },
    ])
  )
  assert.deepEqual(summary, {
    status: 'observed',
    nativeFailures: [
      { code: 'native-shutdown-deadline', phase: 'no-phase-start-observed' },
      { code: 'unclassified', phase: 'process-stop' },
    ],
    fixtureFailures: [0, 1].map(() => ({
      fixture: 'commands',
      passed: false,
      failure: {
        phase: 'shortcut',
        name: 'Error',
        code: null,
        category: 'activation-deadline',
      },
      commandObservations: { status: 'observed', events: ['unclassified'] },
    })),
  })
  assert.equal(JSON.stringify(summary).includes(privateValue), false)
})

test('command diagnostics preserve a bounded callback sequence using only fixed event kinds', () => {
  const privateValue = '/private/example/command?secret=fixture-only'
  const events = [
    { type: 'command', source: 'shortcut', command: privateValue, sequence: privateValue },
    { type: 'menu-shown', privateValue },
    { type: 'menu-closed', privateValue },
    { type: 'menu-closed', privateValue },
    { type: 'command', source: 'menu', command: privateValue },
    { type: 'menu-failed', privateValue },
    { type: 'revoked', privateValue },
    { type: 'command', source: privateValue },
    { type: privateValue },
    privateValue,
    null,
  ]
  const receipt = (observations: unknown) => ({
    event: 'bunly.native.window-commands',
    passed: false,
    failure: 'selected-menu: Error [observation-order]',
    observations,
  })
  const summary = summarizeDesktopFailures(
    'native-window-commands-v1',
    observed([
      receipt(events),
      receipt(Array.from({ length: 32 }, () => ({ type: 'menu-shown' }))),
      receipt(Array.from({ length: 33 }, () => ({ type: 'menu-shown' }))),
      receipt(privateValue),
      receipt([]),
    ])
  )
  assert.deepEqual(
    summary.fixtureFailures.map((entry) => entry.commandObservations),
    [
      {
        status: 'observed',
        events: [
          'command-shortcut',
          'menu-shown',
          'menu-closed',
          'menu-closed',
          'command-menu',
          'menu-failed',
          'revoked',
          'unclassified',
          'unclassified',
          'unclassified',
          'unclassified',
        ],
      },
      { status: 'observed', events: Array(32).fill('menu-shown') },
      { status: 'unavailable', events: [] },
      { status: 'unavailable', events: [] },
      { status: 'observed', events: [] },
    ]
  )
  assert.equal(JSON.stringify(summary).includes(privateValue), false)
})

test('diagnostics distinguish missing or malformed observations without replacing acceptance', () => {
  assert.deepEqual(summarizeDesktopFailures('native-file-downloads-v1'), {
    status: 'not-observed',
    nativeFailures: [],
    fixtureFailures: [],
  })
  assert.deepEqual(
    summarizeDesktopFailures(
      'native-file-downloads-v1',
      observed(
        Array.from({ length: 169 }, () => ({
          event: 'bunly.host.failure',
          error: '/private/fixture',
        }))
      )
    ),
    { status: 'unavailable', nativeFailures: [], fixtureFailures: [] }
  )
  assert.deepEqual(
    summarizeDesktopFailures(
      '/private/profile',
      observed([
        { event: 'bunly.native.window-commands', passed: false, failure: '/private/fixture' },
        { event: 'bunly.host.failure', error: 'Bun input closed' },
      ])
    ),
    {
      status: 'observed',
      nativeFailures: [{ code: 'backend-input-closed', phase: 'no-phase-start-observed' }],
      fixtureFailures: [],
    }
  )
  const success = summarizeDesktopFailures(
    'native-file-dialogs-v1',
    observed([
      { event: 'bunly.native.file-dialogs', passed: true, failure: null },
      { event: 'bunly.native.file-dialogs', passed: true, failure: '/private/contradiction' },
    ])
  )
  assert.deepEqual(success.fixtureFailures, [
    { fixture: 'dialogs', passed: true, failure: null },
    { fixture: 'dialogs', passed: false, failure: unknown },
  ])
})
