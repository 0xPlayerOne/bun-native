import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  DOWNLOAD_LIMITS,
  isPortableDownloadName,
  normalizeDownloadRequest,
  parseDownloadProgress,
  type DownloadProgress,
} from '../packages/contracts/src/index.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'

const request = {
  url: 'https://download.test/file',
  destination: { root: '/owned-downloads', name: 'artifact.bin', overwrite: 'deny' as const },
}
async function fixture(options: { desktopCapabilities?: unknown } = {}) {
  const peer = await nativePeer(options)
  let next = 0
  let nextDownload = 100
  let override: ((command: Command) => boolean) | undefined
  const scope = {
    view: 3,
    session: 1,
    generation: 1,
    mainFrame: 'main',
    document: 'native-3-1',
    origin: 'app://ui',
  }
  peer.handle((command) => {
    if (override?.(command)) return
    if (command.op === 'download.start') peer.reply(command, { id: ++nextDownload })
    else if (command.op === 'policy.scope') peer.reply(command, scope)
    else peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  const session = await backend.createSession({ persistence: 'ephemeral', partition: 'downloads' })
  const window = await backend.createWindow({
    title: 'Downloads',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  })
  const view = await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  const progress = (
    status: DownloadProgress['status'],
    bytesReceived = 0,
    failure: DownloadProgress['failure'] = null,
    id = nextDownload
  ) => {
    peer.send({
      v: 1,
      event: 'download.progress',
      target: 3,
      data: { id, progress: { status, bytesReceived, totalBytes: null, failure } },
    })
  }
  const finish = (
    status: 'completed' | 'cancelled' | 'failed',
    bytesReceived = 0,
    failure: DownloadProgress['failure'] = null,
    id = nextDownload
  ) => {
    progress(status, bytesReceived, failure, id)
    peer.send({
      v: 1,
      event: 'download.finished',
      target: 3,
      data: {
        id,
        outcome: {
          status,
          bytesReceived,
          bytesWritten: status === 'completed' ? bytesReceived : 0,
          failure,
        },
      },
    })
  }
  return {
    ...peer,
    backend,
    session,
    window,
    view,
    scope,
    progress,
    finish,
    intercept(value: typeof override) {
      override = value
    },
  }
}

test('download destinations require explicit overwrite policy and portable single-component names', () => {
  for (const name of ['artifact.bin', 'result-1', 'A_B.c']) assert.ok(isPortableDownloadName(name))
  for (const name of [
    '',
    '..',
    '../outside',
    'a/b',
    'a\\b',
    '/tmp/file',
    'C:secret',
    '.hidden',
    'CON',
    'com1.txt',
    'LPT9',
    'trailing.',
    'space ',
    'résumé',
    'a\n',
    'a'.repeat(129),
  ])
    assert.equal(isPortableDownloadName(name), false, name)
  for (const destination of [
    null,
    {},
    { ...request.destination, overwrite: undefined },
    { ...request.destination, overwrite: true },
    { ...request.destination, name: 'a/b' },
    { ...request.destination, root: 'relative' },
    { ...request.destination, root: '\\\\server\\share' },
    { ...request.destination, extra: true },
  ])
    assert.throws(() => normalizeDownloadRequest({ ...request, destination }))
  const source = structuredClone(request)
  const normalized = normalizeDownloadRequest(source)
  source.destination.name = 'changed'
  assert.equal(normalized.destination.name, 'artifact.bin')
  assert.ok(Object.isFrozen(normalized) && Object.isFrozen(normalized.destination))
  assert.equal(normalized.maxBytes, DOWNLOAD_LIMITS.defaultMaxBytes)
  assert.equal(normalized.timeoutMs, DOWNLOAD_LIMITS.defaultTimeoutMs)
  for (const url of [
    'file:///tmp/secret',
    'app://ui/secret',
    'https://u:p@download.test/file',
    'https://download.test/file#fragment',
    'http://localhost:3000/file',
    'http://remote.test/file',
    'https://download.test/a\nb',
  ])
    assert.throws(() => normalizeDownloadRequest({ ...request, url }))
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5, DOWNLOAD_LIMITS.maxBytes + 1])
    assert.throws(() => normalizeDownloadRequest({ ...request, maxBytes }))
  for (const timeoutMs of [0, 999, -1, NaN, Infinity, 1000.5, DOWNLOAD_LIMITS.maxTimeoutMs + 1])
    assert.throws(() => normalizeDownloadRequest({ ...request, timeoutMs }))
  assert.equal(
    normalizeDownloadRequest({ ...request, url: 'http://127.0.0.1:43001/file' }).url,
    'http://127.0.0.1:43001/file'
  )
})

test('native download progress rejects fabricated shapes and unbounded counters', () => {
  const value = { status: 'in-progress', bytesReceived: 20, totalBytes: null, failure: null }
  assert.ok(Object.isFrozen(parseDownloadProgress(value)))
  for (const invalid of [
    null,
    { ...value, extra: true },
    { ...value, bytesReceived: -1 },
    { ...value, bytesReceived: Number.MAX_SAFE_INTEGER + 1 },
    { ...value, totalBytes: -1 },
    { ...value, failure: 'network' },
    { ...value, status: 'failed' },
    { ...value, status: 'made-up' },
  ])
    assert.throws(() => parseDownloadProgress(invalid))
})

test('legacy hosts reject the additive download facet before native dispatch', async () => {
  const f = await fixture({ desktopCapabilities: undefined })
  try {
    const before = f.commands.length
    await assert.rejects(f.backend.startDownload(f.view, request), {
      code: 'UNSUPPORTED_CAPABILITY',
    })
    assert.equal(f.commands.length, before)
  } finally {
    await f.backend.dispose()
  }
})

test('scoped download admission captures exact native authority and reports actual terminal bytes', async () => {
  const f = await fixture()
  try {
    const operation = await f.backend.startDownload(f.view, request)
    const start = f.commands.find((command) => command.op === 'download.start')!
    assert.deepEqual(start.args, { id: 3, scope: f.scope, ...normalizeDownloadRequest(request) })
    const observations: DownloadProgress[] = []
    operation.onProgress((progress) => observations.push(progress))
    f.progress('starting')
    f.progress('in-progress', 32768)
    f.finish('completed', 65536)
    assert.deepEqual(await operation.completed, {
      status: 'completed',
      bytesReceived: 65536,
      bytesWritten: 65536,
    })
    assert.deepEqual(
      observations.map((progress) => progress.bytesReceived),
      [0, 0, 32768, 65536]
    )
    assert.equal(f.backend.diagnostics().listeners, 0)
    assert.ok(Object.isFrozen(operation) && Object.isFrozen(operation.state()))
  } finally {
    await f.backend.dispose()
  }
})

test('cancellation keeps view capacity until the terminal native receipt, even after acknowledgment', async () => {
  const f = await fixture()
  try {
    const operation = await f.backend.startDownload(f.view, request)
    f.progress('in-progress', 8192)
    const cancelled = operation.cancel()
    assert.strictEqual(operation.cancel(), cancelled)
    let settled = false
    void cancelled.then(() => {
      settled = true
    })
    await turn()
    assert.equal(f.commands.filter((command) => command.op === 'download.cancel').length, 1)
    assert.equal(settled, false)
    await assert.rejects(f.backend.startDownload(f.view, request), { code: 'RESOURCE_IN_USE' })
    f.progress('cancelling', 8192)
    f.finish('cancelled', 8192)
    assert.deepEqual(await cancelled, { status: 'cancelled', bytesReceived: 8192, bytesWritten: 0 })
    const replacement = await f.backend.startDownload(f.view, request)
    f.finish('completed', 5)
    assert.equal((await replacement.completed).bytesWritten, 5)
  } finally {
    await f.backend.dispose()
  }
})

test('abort during admission still obtains the native owner then cancels it', async () => {
  const f = await fixture()
  try {
    let start: Command | undefined
    f.intercept((command) => {
      if (command.op === 'download.start') {
        start = command
        return true
      }
      return false
    })
    const controller = new AbortController()
    const pending = f.backend.startDownload(f.view, request, { signal: controller.signal })
    await turn()
    assert.ok(start)
    controller.abort()
    assert.equal(f.commands.filter((command) => command.op === 'download.cancel').length, 0)
    f.reply(start, { id: 101 })
    const operation = await pending
    await turn()
    assert.equal(f.commands.filter((command) => command.op === 'download.cancel').length, 1)
    f.finish('cancelled', 0, null, 101)
    assert.equal((await operation.completed).status, 'cancelled')
  } finally {
    await f.backend.dispose()
  }
})

test('pre-aborted downloads make no policy capture or native admission', async () => {
  const f = await fixture()
  try {
    const before = f.commands.length
    await assert.rejects(
      f.backend.startDownload(f.view, request, { signal: AbortSignal.abort() }),
      { name: 'AbortError' }
    )
    assert.equal(f.commands.length, before)
  } finally {
    await f.backend.dispose()
  }
})

test('native permission denial creates no operation and a later valid request may proceed', async () => {
  const f = await fixture()
  try {
    f.intercept((command) => {
      if (command.op !== 'download.start') return false
      f.reject(command, 'PERMISSION_DENIED: missing download root')
      return true
    })
    await assert.rejects(f.backend.startDownload(f.view, request), /PERMISSION_DENIED/)
    f.intercept(undefined)
    const operation = await f.backend.startDownload(f.view, request)
    f.finish('failed', 4096, 'network')
    assert.deepEqual(await operation.completed, {
      status: 'failed',
      bytesReceived: 4096,
      bytesWritten: 0,
      failure: 'network',
    })
  } finally {
    await f.backend.dispose()
  }
})

test('download progress listener errors are isolated and their registrations are bounded', async () => {
  const f = await fixture()
  try {
    const operation = await f.backend.startDownload(f.view, request)
    for (let index = 0; index < DOWNLOAD_LIMITS.listeners; index++)
      operation.onProgress(() => {
        throw new Error('listener')
      })
    assert.throws(() => operation.onProgress(() => {}), { code: 'RESOURCE_IN_USE' })
    assert.equal(f.backend.diagnostics().listeners, DOWNLOAD_LIMITS.listeners)
    assert.equal(f.backend.diagnostics().listenerErrors, DOWNLOAD_LIMITS.listeners)
    f.finish('completed', 1)
    await operation.completed
    assert.equal(f.backend.diagnostics().listeners, 0)
  } finally {
    await f.backend.dispose()
  }
})

test('a forged native operation identity fails the transport without accepting completion', async () => {
  const f = await fixture()
  const operation = await f.backend.startDownload(f.view, request)
  f.finish('completed', 1, null, 999)
  await assert.rejects(operation.completed, /mismatched native download/)
  await assert.rejects(f.backend.closed, /mismatched native download/)
  f.stop()
})

test('regressing native counters are rejected, not repaired into invented progress', async () => {
  const f = await fixture()
  const operation = await f.backend.startDownload(f.view, request)
  f.progress('in-progress', 100)
  f.progress('in-progress', 99)
  await assert.rejects(operation.completed, /state transition/)
  await assert.rejects(f.backend.closed, /state transition/)
  f.stop()
})

test('legacy download convenience requires an explicit destination and preserves its result contract', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.backend.download(f.view, { url: request.url }), {
      code: 'INVALID_ARGUMENT',
    })
    const result = f.backend.download(f.view, request)
    await turn()
    f.finish('completed', 256)
    assert.deepEqual(await result, { status: 'completed', bytesWritten: 256 })
  } finally {
    await f.backend.dispose()
  }
})

test('coalesced native admission and progress preserve the operation identity', async () => {
  const f = await fixture()
  try {
    f.intercept((command) => {
      if (command.op !== 'download.start') return false
      f.input.write(
        [
          { v: 1, id: command.id, ok: true, value: { id: 101 } },
          {
            v: 1,
            event: 'download.progress',
            target: 3,
            data: {
              id: 101,
              progress: { status: 'starting', bytesReceived: 0, totalBytes: null, failure: null },
            },
          },
          {
            v: 1,
            event: 'download.progress',
            target: 3,
            data: {
              id: 101,
              progress: {
                status: 'in-progress',
                bytesReceived: 42,
                totalBytes: 100,
                failure: null,
              },
            },
          },
        ]
          .map((row) => JSON.stringify(row) + '\n')
          .join('')
      )
      return true
    })
    const operation = await f.backend.startDownload(f.view, request)
    await turn()
    assert.equal(operation.state().bytesReceived, 42)
    f.finish('completed', 100, null, 101)
    assert.equal((await operation.completed).bytesWritten, 100)
  } finally {
    await f.backend.dispose()
  }
})

test('a document change during admission cancels the native owner and retains its capacity', async () => {
  const f = await fixture()
  try {
    let admission: Command | undefined
    f.intercept((command) => {
      if (command.op !== 'download.start') return false
      admission = command
      return true
    })
    const starting = f.backend.startDownload(f.view, request)
    const rejected = assert.rejects(starting, /stale|changed|revoked/i)
    await turn()
    assert.ok(admission)
    f.send({
      v: 1,
      event: 'view.navigating',
      target: 3,
      data: { url: 'app://ui/next.html', documentId: 'native-3-2', applicationTrust: true },
    })
    await turn()
    f.scope.document = 'native-3-2'
    f.scope.generation = 2
    f.reply(admission, { id: 101 })
    await rejected
    await turn()
    assert.equal(f.commands.filter((command) => command.op === 'download.cancel').length, 1)
    await assert.rejects(f.backend.startDownload(f.view, request), { code: 'RESOURCE_IN_USE' })
    f.finish('cancelled', 0, null, 101)
    await turn()
    f.intercept(undefined)
    const next = await f.backend.startDownload(f.view, request)
    f.finish('completed', 4)
    assert.equal((await next.completed).bytesWritten, 4)
  } finally {
    await f.backend.dispose()
  }
})

test('view disposal may settle only after its outstanding download terminal receipt', async () => {
  const f = await fixture()
  try {
    const operation = await f.backend.startDownload(f.view, request)
    let close: Command | undefined
    f.intercept((command) => {
      if (command.op !== 'view.dispose') return false
      close = command
      return true
    })
    const disposing = f.backend.disposeView(f.view)
    let closed = false
    void disposing.then(() => {
      closed = true
    })
    await turn()
    assert.ok(close)
    assert.equal(closed, false)
    f.progress('cancelling', 4096)
    f.finish('cancelled', 4096)
    assert.equal((await operation.completed).status, 'cancelled')
    assert.equal(closed, false)
    f.reply(close)
    await disposing
    assert.equal(f.backend.diagnostics().views, 0)
  } finally {
    await f.backend.dispose()
  }
})

test('native loss rejects owned downloads and releases local listeners without inventing settlement', async () => {
  const f = await fixture()
  const operation = await f.backend.startDownload(f.view, request)
  operation.onProgress(() => {})
  const completed = assert.rejects(operation.completed, /fixture native loss/)
  const closed = assert.rejects(f.backend.closed, /fixture native loss/)
  f.transport.fail(new Error('fixture native loss'))
  await Promise.all([completed, closed])
  assert.equal(f.backend.diagnostics().listeners, 0)
  assert.equal(operation.state().status, 'starting')
  await f.stop()
})

test('application quitting still permits owned cancellation and retains it until terminal settlement', async () => {
  const f = await fixture()
  const operation = await f.backend.startDownload(f.view, request)
  operation.onProgress(() => {})
  f.progress('in-progress', 4096)
  f.send({ v: 1, event: 'app.quitting', data: { reason: 'native' } })
  await turn()
  assert.equal(f.backend.applicationState().phase, 'quitting')
  await assert.rejects(f.backend.startDownload(f.view, request), { code: 'DISPOSED' })
  let settled = false
  const cancellation = operation.cancel().then((value) => {
    settled = true
    return value
  })
  await turn()
  assert.equal(settled, false)
  assert.equal(f.backend.diagnostics().listeners, 1)
  assert.equal(f.transport.failure, null)
  const command = f.commands.find((command) => command.op === 'download.cancel')
  assert.deepEqual(command?.args, { id: 3, download: 101 })
  f.finish('cancelled', 4096)
  assert.deepEqual(await cancellation, {
    status: 'cancelled',
    bytesReceived: 4096,
    bytesWritten: 0,
  })
  f.send({ v: 1, event: 'shutdown', data: { failed: false } })
  await f.backend.closed
  assert.equal(f.backend.applicationState().outcome, 'orderly')
  assert.equal(f.backend.diagnostics().listeners, 0)
  assert.equal(f.transport.failure, null)
})
