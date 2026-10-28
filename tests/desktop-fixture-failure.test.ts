import { test, spyOn } from 'bun:test'
import assert from 'node:assert/strict'
import { BunlyError, type WindowCommandsEvent } from '../packages/contracts/src/index.ts'
import type { CefBackend } from '../packages/runtime/src/cef.ts'
import windowCommands from '../examples/window-commands/fixture.ts'
import fileDialogs from '../examples/file-dialogs/fixture.ts'
import { classifyDesktopFixtureFailure } from '../benchmarks/desktop/failure-codes.ts'
import { acceptWindowCommandsReceipt } from '../benchmarks/desktop/commands-acceptance.ts'

/** Fail before creating native resources. This checks fixture diagnostics, not native execution. */
function rejectedBackend(error: unknown, cleanupError?: unknown): CefBackend {
  return {
    closed: new Promise<void>(() => {}),
    whenApplicationReady: async () => {
      throw error
    },
    createSession: async () => {
      throw error
    },
    onEvent: () => () => {},
    observe: () => () => {},
    dispose: async () => {
      if (cleanupError) throw cleanupError
    },
    diagnostics: () => ({ windows: 0, views: 0, sessions: 0, listeners: 0, listenerErrors: 0 }),
  } as unknown as CefBackend
}

test('commands fixture retains its first classified failure when cleanup also fails', async () => {
  const privateMessage = '/private/example/commands?secret=fixture-only'
  const error = Object.assign(new Error(privateMessage), {
    name: 'AssertionError',
    code: 'ERR_ASSERTION',
  })
  const lines: unknown[][] = []
  const output = spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    lines.push(values)
  })
  try {
    await assert.rejects(windowCommands(rejectedBackend(error, new Error(privateMessage))), {
      message:
        'Native window commands qualification failed: ready: AssertionError (ERR_ASSERTION) [assertion]',
    })
  } finally {
    output.mockRestore()
  }
  assert.equal(lines.length, 1)
  const receipt = JSON.parse(String(lines[0]![0])) as Record<string, unknown>
  assert.equal(receipt['event'], 'bunly.native.window-commands')
  assert.equal(receipt['passed'], false)
  assert.equal(receipt['shutdownSucceeded'], false)
  assert.deepEqual(classifyDesktopFixtureFailure('commands', receipt['failure']), {
    phase: 'ready',
    name: 'AssertionError',
    code: 'ERR_ASSERTION',
    category: 'assertion',
  })
  assert.equal(JSON.stringify(lines).includes(privateMessage), false)
})

test('commands fixture retains actual partial callbacks when menu selection fails', async () => {
  let nativeEvent: Parameters<CefBackend['observe']>[0] = () => {}
  let commandEvent: Parameters<CefBackend['onWindowCommandsEvent']>[1] = () => {}
  let registrations = 0
  const actual: WindowCommandsEvent[] = [
    { type: 'command', source: 'shortcut', command: 'record', sequence: 1 },
    { type: 'menu-shown', sequence: 2 },
    { type: 'menu-closed', sequence: 3 },
  ]
  // A portable rejected trace, not evidence of real input or native ownership.
  const backend = {
    ...rejectedBackend(undefined),
    descriptor: { capabilities: ['window.commands'] },
    whenApplicationReady: async () => {},
    createSession: async () => ({}),
    createWindow: async () => ({}),
    createView: async () => {
      nativeEvent({
        v: 1,
        event: 'view.loaded',
        data: { url: 'app://ui/index.html', documentId: 'fixture-document' },
      })
      return {}
    },
    observe: (listener: typeof nativeEvent) => {
      nativeEvent = listener
      return () => {}
    },
    state: () => ({
      documentId: 'fixture-document',
      url: 'app://ui/index.html',
      trust: { kind: 'application' },
    }),
    capturePolicyScope: async () => ({}),
    grantNativeCapability: async () => {},
    createWindowCommands: async () => {
      registrations++
      if (registrations <= 2) throw new BunlyError('PERMISSION_DENIED', 'Fixture denial')
      if (registrations === 3) throw new BunlyError('INVALID_ARGUMENT', 'Fixture bound')
      if (registrations === 5) throw new BunlyError('RESOURCE_IN_USE', 'Fixture duplicate')
      return {}
    },
    onWindowCommandsEvent: (_handle: unknown, listener: typeof commandEvent) => {
      commandEvent = listener
      return () => {}
    },
    onWindowEvent: () => () => {},
    activateWindow: async () => ({ active: true }),
    windowState: async () => ({ active: true }),
    qualifyWindowCommands: async (_handle: unknown, action: string) => {
      if (action === 'shortcut') commandEvent(actual[0]!)
    },
    showWindowMenu: async () => {
      for (const event of actual.slice(1)) commandEvent(event)
    },
  } as unknown as CefBackend
  const lines: unknown[][] = []
  const output = spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    lines.push(values)
  })
  try {
    await assert.rejects(windowCommands(backend), {
      message:
        'Native window commands qualification failed: selected-menu: Error [observation-order]',
    })
  } finally {
    output.mockRestore()
  }
  assert.equal(lines.length, 1)
  const receipt = JSON.parse(String(lines[0]![0])) as Record<string, unknown>
  assert.equal(receipt['passed'], false)
  assert.deepEqual(receipt['observations'], actual)
  assert.throws(() => acceptWindowCommandsReceipt(receipt))
})

test('dialog fixture reports bounded error identity without exporting its message or temporary path', async () => {
  const privateMessage = '/private/example/dialogs?secret=fixture-only'
  const lines: unknown[][] = []
  const output = spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    lines.push(values)
  })
  try {
    await assert.rejects(
      fileDialogs(rejectedBackend(new BunlyError('PERMISSION_DENIED', privateMessage))),
      {
        message:
          'Native file dialog fixture failed at setup: BunlyError (PERMISSION_DENIED) [unclassified]',
      }
    )
  } finally {
    output.mockRestore()
  }
  assert.equal(lines.length, 1)
  const receipt = JSON.parse(String(lines[0]![0])) as Record<string, unknown>
  assert.equal(receipt['event'], 'bunly.native.file-dialogs')
  assert.equal(receipt['passed'], false)
  assert.deepEqual(receipt['checks'], { temporaryDirectoryRemoved: true })
  assert.deepEqual(classifyDesktopFixtureFailure('dialogs', receipt['failure']), {
    phase: 'setup',
    name: 'BunlyError',
    code: 'PERMISSION_DENIED',
    category: 'unclassified',
  })
  assert.equal(JSON.stringify(lines).includes(privateMessage), false)
  assert.equal(JSON.stringify(lines).includes('bunly-dialogs-'), false)
})
