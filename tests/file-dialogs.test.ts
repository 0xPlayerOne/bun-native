import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  BunlyError,
  normalizeFileDialog,
  validSelectedFilePath,
  type PolicyScope,
} from '../packages/contracts/src/index.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { ManagedDesktopResources } from '../packages/runtime/src/managed-desktop.ts'
import { ManagedGenerationOwner } from '../packages/runtime/src/managed-generations.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'

const dialog = { directory: '/owned-fixture', title: 'Choose test file' }
const code = (name: string) => (error: unknown) =>
  error instanceof BunlyError && error.code === name

async function fixture(options: { desktopCapabilities?: unknown } = {}) {
  const peer = await nativePeer(options)
  let next = 0
  let nextDialog = 100
  let override: ((command: Command) => boolean) | undefined
  peer.handle((command) => {
    if (override?.(command)) return
    if (command.op === 'dialog.show') peer.reply(command, { id: ++nextDialog })
    else if (command.op === 'policy.scope')
      peer.reply(command, {
        view: 3,
        session: 1,
        generation: 1,
        mainFrame: 'main',
        document: 'native-3-1',
        origin: 'app://ui',
      })
    else peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  const session = await backend.createSession({ persistence: 'ephemeral', partition: 'dialogs' })
  const window = await backend.createWindow({
    title: 'File dialog contract',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  })
  const view = await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  const scope = await backend.capturePolicyScope(view)
  const finish = (
    status: 'selected' | 'cancelled' | 'failed',
    path: unknown = null,
    error: unknown = null
  ) =>
    peer.send({
      v: 1,
      event: 'dialog.finished',
      target: 3,
      data: { id: nextDialog, status, path, error },
    })
  return {
    ...peer,
    backend,
    view,
    scope,
    finish,
    intercept(value: typeof override) {
      override = value
    },
  }
}

test('file dialog options require bounded literal text, explicit directory and a basename', () => {
  assert.deepEqual(normalizeFileDialog('open', dialog), { ...dialog, suggestedName: '' })
  assert.deepEqual(normalizeFileDialog('save', { directory: '/', suggestedName: 'é.txt' }), {
    directory: '/',
    suggestedName: 'é.txt',
    title: '',
  })
  for (const value of [
    null,
    [],
    {},
    { directory: 'relative' },
    { directory: '/own/../private' },
    { ...dialog, unexpected: 1 },
    { ...dialog, title: '\ud800' },
    { ...dialog, title: '\u0085' },
    { ...dialog, title: 'é'.repeat(129) },
    { ...dialog, directory: '/' + 'a'.repeat(4096) },
  ])
    assert.throws(() => normalizeFileDialog('open', value), code('INVALID_ARGUMENT'))
  for (const suggestedName of [
    '',
    '.',
    '..',
    '../private',
    'a\\b',
    'x:y',
    'line\nfile',
    'é'.repeat(128),
  ])
    assert.throws(
      () => normalizeFileDialog('save', { ...dialog, suggestedName }),
      code('INVALID_ARGUMENT')
    )
  assert.equal(validSelectedFilePath('/owned/é.txt'), true)
  assert.equal(validSelectedFilePath('file:///owned/file'), false)
})

test('file selection uses the exact captured scope; forged or unsupported calls send no native command', async () => {
  const f = await fixture()
  try {
    const count = f.commands.length
    await assert.rejects(
      f.backend.showOpenFileDialog({ ...f.scope } as PolicyScope, dialog),
      code('PERMISSION_DENIED')
    )
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(
      f.backend.showOpenFileDialog(f.scope, dialog, { signal: aborted.signal }),
      /abort/i
    )
    assert.equal(f.commands.length, count)
    const pending = f.backend.showSaveFileDialog(f.scope, {
      ...dialog,
      suggestedName: 'report.txt',
    })
    await turn()
    const call = f.commands.at(-1)!
    assert.equal(call.op, 'dialog.show')
    assert.equal(call.args['kind'], 'save')
    assert.deepEqual(call.args['scope'], {
      view: 3,
      session: 1,
      generation: 1,
      mainFrame: 'main',
      document: 'native-3-1',
      origin: 'app://ui',
    })
    f.finish('selected', '/owned-fixture/report.txt')
    assert.deepEqual(await pending, { status: 'selected', path: '/owned-fixture/report.txt' })
    assert.equal(
      f.commands.some((command) => ['download.start', 'policy.native.grant'].includes(command.op)),
      false
    )
  } finally {
    await f.stop()
  }
  const unsupported = await fixture({
    desktopCapabilities: { version: 1, capabilities: ['app.lifecycle'] },
  })
  try {
    const count = unsupported.commands.length
    await assert.rejects(
      unsupported.backend.showOpenFileDialog(unsupported.scope, dialog),
      code('UNSUPPORTED_CAPABILITY')
    )
    await assert.rejects(
      unsupported.backend.showSaveFileDialog(unsupported.scope, {
        ...dialog,
        suggestedName: 'unused.txt',
      }),
      code('UNSUPPORTED_CAPABILITY')
    )
    assert.equal(unsupported.commands.length, count)
  } finally {
    await unsupported.stop()
  }
})

test('abort before admission retains the sole slot through cancellation ack until real dismissal', async () => {
  const f = await fixture()
  try {
    f.intercept((command) => command.op === 'dialog.show')
    const signal = new AbortController()
    let settled = false
    const pending = f.backend
      .showOpenFileDialog(f.scope, dialog, { signal: signal.signal })
      .then((value) => {
        settled = true
        return value
      })
    const admission = f.commands.at(-1)!
    signal.abort()
    assert.equal(f.commands.filter((command) => command.op === 'dialog.cancel').length, 0)
    await assert.rejects(f.backend.showOpenFileDialog(f.scope, dialog), code('RESOURCE_IN_USE'))
    f.reply(admission, { id: 100 })
    await turn()
    assert.equal(f.commands.at(-1)!.op, 'dialog.cancel')
    assert.equal(settled, false)
    await assert.rejects(f.backend.showOpenFileDialog(f.scope, dialog), code('RESOURCE_IN_USE'))
    f.finish('cancelled')
    assert.deepEqual(await pending, { status: 'cancelled' })
    assert.equal(f.transport.diagnostics().abandoned, 0)
  } finally {
    await f.stop()
  }
})

test('a selection arriving after abort is discarded while the native terminal event still frees ownership', async () => {
  const f = await fixture()
  try {
    const signal = new AbortController()
    const pending = f.backend.showOpenFileDialog(f.scope, dialog, { signal: signal.signal })
    await turn()
    signal.abort()
    await turn()
    f.finish('selected', '/owned-fixture/late.txt')
    assert.deepEqual(await pending, { status: 'cancelled' })
    const next = f.backend.showOpenFileDialog(f.scope, dialog)
    await turn()
    f.finish('cancelled')
    assert.deepEqual(await next, { status: 'cancelled' })
  } finally {
    await f.stop()
  }
})

test('selection cannot cross a document generation change or native failure', async () => {
  const f = await fixture()
  try {
    const pending = f.backend.showOpenFileDialog(f.scope, dialog)
    const rejected = assert.rejects(pending, code('PERMISSION_DENIED'))
    await turn()
    f.send({ v: 1, event: 'view.navigating', target: 3, data: { url: 'app://ui/index.html' } })
    f.finish('selected', '/owned-fixture/stale.txt')
    await rejected
  } finally {
    await f.stop()
  }
  const failed = await fixture()
  try {
    const pending = failed.backend.showOpenFileDialog(failed.scope, dialog)
    const rejected = assert.rejects(pending, code('PERMISSION_DENIED'))
    await turn()
    failed.finish('failed', null, 'PERMISSION_DENIED')
    await rejected
  } finally {
    await failed.stop()
  }
})

test('malformed or foreign dialog completion fails the channel instead of exposing paths', async () => {
  for (const frame of [
    { id: 999, status: 'cancelled', path: null, error: null },
    { id: 101, status: 'selected', path: '../private', error: null },
    { id: 101, status: 'cancelled', path: '/private', error: null },
    { id: 101, status: 'failed', path: null, error: 'invented' },
  ]) {
    const f = await fixture()
    const pending = f.backend.showOpenFileDialog(f.scope, dialog)
    const rejected = assert.rejects(pending, /native.*dialog|dialog.*completion/i)
    await turn()
    f.send({ v: 1, event: 'dialog.finished', target: 3, data: frame })
    await rejected
    await assert.rejects(f.backend.closed)
  }
})

test('native quitting still allows only the existing dialog cancellation to drain', async () => {
  const f = await fixture()
  const signal = new AbortController()
  const pending = f.backend.showOpenFileDialog(f.scope, dialog, { signal: signal.signal })
  await turn()
  f.backend.onApplicationEvent((event) => {
    if (event.type === 'quitting') signal.abort()
  })
  f.send({ v: 1, event: 'app.quitting', data: { reason: 'native' } })
  await turn()
  assert.equal(f.commands.at(-1)!.op, 'dialog.cancel')
  await assert.rejects(f.backend.showOpenFileDialog(f.scope, dialog), code('DISPOSED'))
  f.finish('cancelled')
  assert.deepEqual(await pending, { status: 'cancelled' })
  await f.stop()
})

test('managed retirement aborts a panel but retains work and resource until native completion', async () => {
  const f = await fixture()
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, f.backend)
  try {
    const authority = await desktop.captureAuthority(f.view)
    const resource = desktop.registerFileDialogs('file-selection', {
      authority,
      permission: 'dialog',
      operations: ['open'],
    })
    const generation = owner.begin('dialog:1', ['dialog'])
    owner.attach(generation, resource, 'bunly.dialog:1')
    owner.commit(generation, '{}')
    const pending = owner.invoke(generation, resource, 'open', JSON.stringify(dialog))
    const rejected = assert.rejects(pending, /RETIRED/)
    await turn()
    assert.equal(f.commands.at(-1)!.op, 'dialog.show')
    owner.retire(generation)
    await rejected
    await turn()
    assert.equal(f.commands.at(-1)!.op, 'dialog.cancel')
    assert.equal(owner.diagnostics().inFlight, 1)
    let closed = false
    const closing = desktop.close('file-selection').then(() => {
      closed = true
    })
    await turn()
    assert.equal(closed, false)
    f.finish('cancelled')
    await closing
    assert.equal(owner.diagnostics().inFlight, 0)
    assert.equal(owner.diagnostics().resources, 0)
    await assert.rejects(
      owner.invoke(generation, resource, 'open', JSON.stringify(dialog)),
      /RETIRED|INVALID_IDENTITY/
    )
  } finally {
    await desktop.dispose()
    owner.dispose()
    await f.stop()
  }
})
