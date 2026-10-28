import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  CefBrowserActions,
  parseBrowserObservation,
  validateBrowserAction,
  type NativeBrowserAction,
} from '../packages/runtime/src/cef-browser-actions.ts'
import { BROWSER_ACTION_LIMITS } from '../packages/contracts/src/browser-actions.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'

async function fixture(payload: Uint8Array = Buffer.from('{"defined":true,"value":"bounded"}')) {
  const peer = await nativePeer()
  const controller = new CefBrowserActions(peer.transport)
  peer.transport.onEvent((event) => {
    try {
      controller.event(event)
    } catch (error) {
      peer.transport.fail(error)
    }
  })
  void peer.transport.closed.then(() =>
    controller.close(peer.transport.failure ?? new Error('Closed'))
  )
  let next = 100
  let override: ((command: Command) => boolean) | undefined
  const operations = new Map<number, number>()
  const sendReady = (view = 3, bytes = payload.length, width = 0, height = 0) =>
    peer.send({
      v: 1,
      event: 'browser.action.ready',
      target: view,
      data: {
        id: operations.get(view),
        bytes,
        sha256: createHash('sha256').update(payload).digest('hex'),
        width,
        height,
      },
    })
  const finish = (view = 3, failure = 'cancelled') =>
    peer.send({
      v: 1,
      event: 'browser.action.finished',
      target: view,
      data: { id: operations.get(view), failure },
    })
  peer.handle((command) => {
    if (override?.(command)) return
    if (command.op === 'browser.action.start') {
      const view = Number(command.args['id'])
      operations.set(view, ++next)
      peer.reply(command, { id: next })
    } else if (command.op === 'browser.action.read') {
      const offset = Number(command.args['offset'])
      peer.reply(command, {
        id: command.args['operation'],
        offset,
        hex: Buffer.from(payload.subarray(offset, offset + 4096)).toString('hex'),
      })
    } else peer.reply(command)
  })
  return {
    ...peer,
    controller,
    sendReady,
    finish,
    operations,
    override(handler: (command: Command) => boolean) {
      override = handler
    },
    run(
      view = 3,
      action: NativeBrowserAction = { kind: 'evaluate', expression: 'document.title' },
      check = () => {},
      signal?: AbortSignal
    ) {
      return controller.run(
        view,
        {
          view,
          session: 2,
          generation: 1,
          mainFrame: 'main',
          document: 'doc',
          origin: 'https://remote.test',
        },
        action,
        check,
        signal
      )
    },
  }
}

test('browser result is transferred in bounded chunks and released before delivery', async () => {
  const f = await fixture()
  try {
    const result = f.run()
    await turn()
    f.sendReady()
    assert.equal(await result, 'bounded')
    assert.deepEqual(f.controller.diagnostics, { operations: 0, reservedBytes: 0 })
    assert.deepEqual(
      f.commands.map((command) => command.op),
      ['browser.action.start', 'browser.action.read', 'browser.action.release']
    )
  } finally {
    await f.stop()
  }
})
test('pre-aborted browser actions never enter native admission', async () => {
  const f = await fixture()
  try {
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(
      f.run(3, { kind: 'dom' }, () => {}, abort.signal),
      /abort/i
    )
    assert.equal(f.commands.length, 0)
  } finally {
    await f.stop()
  }
})
test('cancel ACK retains per-view and byte owners until native completion', async () => {
  const f = await fixture()
  try {
    const abort = new AbortController()
    const rejected = assert.rejects(
      f.run(3, { kind: 'dom' }, () => {}, abort.signal),
      /abort/i
    )
    await turn()
    abort.abort()
    await turn()
    assert.equal(f.commands.filter((command) => command.op === 'browser.action.cancel').length, 1)
    assert.equal(f.controller.diagnostics.operations, 1)
    await assert.rejects(f.run(), /capacity/)
    f.finish()
    await rejected
    assert.equal(f.controller.diagnostics.reservedBytes, 0)
  } finally {
    await f.stop()
  }
})
test('abort before admission ACK cancels exactly once after native ID arrives', async () => {
  const f = await fixture()
  let admission: Command | undefined
  f.override((command) => {
    if (command.op !== 'browser.action.start') return false
    admission = command
    f.operations.set(3, 101)
    return true
  })
  try {
    const abort = new AbortController()
    const rejected = assert.rejects(
      f.run(3, { kind: 'dom' }, () => {}, abort.signal),
      /abort/i
    )
    abort.abort()
    await turn()
    assert.equal(f.commands.length, 1)
    f.reply(admission!, { id: 101 })
    await turn()
    assert.equal(f.commands.filter((command) => command.op === 'browser.action.cancel').length, 1)
    f.finish()
    await rejected
  } finally {
    await f.stop()
  }
})
test('coalesced early readiness is checked against the admission ACK', async () => {
  const f = await fixture()
  f.override((command) => {
    if (command.op !== 'browser.action.start') return false
    f.operations.set(3, 101)
    f.sendReady()
    f.reply(command, { id: 101 })
    return true
  })
  try {
    assert.equal(await f.run(), 'bounded')
  } finally {
    await f.stop()
  }
})
test('navigation after readiness denies the result and waits for cleanup receipt', async () => {
  const f = await fixture()
  try {
    let live = true
    const rejected = assert.rejects(
      f.run(3, { kind: 'evaluate', expression: 'document.title' }, () => {
        if (!live) throw new Error('Stale native target')
      }),
      /Stale native target/
    )
    await turn()
    live = false
    f.sendReady()
    await turn()
    assert.equal(
      f.commands.some((command) => command.op === 'browser.action.read'),
      false
    )
    assert.equal(f.controller.diagnostics.operations, 1)
    f.finish(3, 'stale-target')
    await rejected
  } finally {
    await f.stop()
  }
})
test('completion during a pending read retains local buffers until the read unwinds', async () => {
  const f = await fixture()
  let read: Command | undefined
  f.override((command) => {
    if (command.op !== 'browser.action.read') return false
    read = command
    return true
  })
  try {
    const rejected = assert.rejects(f.run(), /stale-target/)
    await turn()
    f.sendReady()
    await turn()
    f.finish(3, 'stale-target')
    assert.equal(f.controller.diagnostics.operations, 1)
    f.reply(read!, { id: 101, offset: 0, hex: '00' })
    await rejected
    assert.equal(f.controller.diagnostics.reservedBytes, 0)
    assert.equal(
      f.commands.some((command) => command.op === 'browser.action.release'),
      false
    )
  } finally {
    await f.stop()
  }
})
test('the global byte budget denies admission before sending a native request', async () => {
  const f = await fixture()
  try {
    const settled = [3, 4].map((view) => assert.rejects(f.run(view), /cancelled/i))
    await turn()
    assert.equal(f.controller.diagnostics.reservedBytes, 6 * 1024 * 1024)
    await assert.rejects(f.run(7), /capacity/)
    for (const view of [3, 4]) f.finish(view)
    await Promise.all(settled)
  } finally {
    await f.stop()
  }
})
test('oversized PNG metadata is denied before allocation or native read', async () => {
  const f = await fixture()
  try {
    const rejected = assert.rejects(
      f.run(3, { kind: 'screenshot', width: 1024, height: 768 }),
      /bound/
    )
    await turn()
    f.sendReady(3, BROWSER_ACTION_LIMITS.screenshotBytes + 1, 1024, 768)
    await turn()
    assert.equal(
      f.commands.some((command) => command.op === 'browser.action.read'),
      false
    )
    f.finish()
    await rejected
  } finally {
    await f.stop()
  }
})
test('malformed chunk offsets are denied instead of returning empty success', async () => {
  const f = await fixture()
  f.override((command) => {
    if (command.op !== 'browser.action.read') return false
    f.reply(command, { id: 101, offset: 9, hex: '00' })
    return true
  })
  try {
    const rejected = assert.rejects(f.run(), /chunk/)
    await turn()
    f.sendReady()
    await turn()
    f.finish()
    await rejected
  } finally {
    await f.stop()
  }
})
test('a PNG result has verified dimensions and decoded owned bytes', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=',
    'base64'
  )
  const f = await fixture(png)
  try {
    const result = f.run(3, { kind: 'screenshot', width: 32, height: 32 })
    await turn()
    f.sendReady(3, png.length, 1, 1)
    assert.deepEqual(await result, {
      format: 'png',
      width: 1,
      height: 1,
      data: new Uint8Array(png),
    })
  } finally {
    await f.stop()
  }
})
test('observation ancestry, depth, Unicode text length and nonempty results are enforced', () => {
  const node = { id: 1, depth: 0, role: 'document', name: '😀'.repeat(512), text: '' }
  assert.equal(
    parseBrowserObservation({ kind: 'dom', nodes: [node], truncated: false }, 'dom').nodes.length,
    1
  )
  for (const nodes of [
    [],
    [{ ...node, depth: 1 }],
    [{ ...node, parent: 1 }],
    [{ ...node, name: '😀'.repeat(513) }],
    [node, { ...node, id: 2, depth: 4, parent: 1 }],
  ])
    assert.throws(() => parseBrowserObservation({ kind: 'dom', nodes, truncated: false }, 'dom'))
})
test('evaluation and synthetic input UTF-8 limits reject oversized data before transport', () => {
  assert.throws(() => validateBrowserAction({ kind: 'evaluate', expression: 'é'.repeat(2049) }))
  assert.throws(() =>
    validateBrowserAction({ kind: 'input', action: { type: 'text', text: '😀'.repeat(1025) } })
  )
  assert.throws(() =>
    validateBrowserAction({
      kind: 'input',
      action: { type: 'pointer', x: Number.NaN, y: 0, button: 'left' },
    })
  )
  assert.throws(() => validateBrowserAction({ kind: 'screenshot', width: 1025, height: 1 }))
})
test('scope capture is included in shared admission before its first await', async () => {
  const f = await fixture()
  const scopes = [
    Promise.withResolvers<Record<string, unknown>>(),
    Promise.withResolvers<Record<string, unknown>>(),
  ]
  let captures = 0
  const capture = () => scopes[captures++]!.promise
  try {
    const pending = [3, 4].map((view) =>
      assert.rejects(
        f.controller.run(view, capture, { kind: 'dom' }, () => {}),
        /scope failed/
      )
    )
    assert.equal(captures, 2)
    await assert.rejects(
      f.controller.run(5, capture, { kind: 'dom' }, () => {}),
      /capacity/
    )
    await assert.rejects(
      f.controller.run(3, capture, { kind: 'dom' }, () => {}),
      /capacity/
    )
    assert.equal(captures, 2)
    assert.equal(f.commands.length, 0)
    for (const scope of scopes) scope.reject(new Error('scope failed'))
    await Promise.all(pending)
    assert.equal(f.controller.diagnostics.operations, 0)
  } finally {
    await f.stop()
  }
})
test('malformed successful admission closes transport before freeing its possible native owner', async () => {
  for (const ack of [{ id: 0 }, { id: 101, extra: true }]) {
    const f = await fixture()
    const fail = f.transport.fail.bind(f.transport)
    let failedWithOwner = false
    f.transport.fail = (error: unknown) => {
      failedWithOwner = f.controller.diagnostics.operations === 1
      fail(error)
    }
    f.override((command) => {
      if (command.op !== 'browser.action.start') return false
      f.reply(command, ack)
      return true
    })
    try {
      await assert.rejects(f.run(), /Malformed/)
      assert.equal(failedWithOwner, true)
      assert.equal(f.transport.diagnostics().closed, true)
      assert.equal(f.controller.diagnostics.operations, 0)
    } finally {
      await f.stop()
    }
  }
})
test('mismatched buffered early receipt closes transport with admission still held', async () => {
  const f = await fixture()
  const fail = f.transport.fail.bind(f.transport)
  let failedWithOwner = false
  f.transport.fail = (error: unknown) => {
    failedWithOwner = f.controller.diagnostics.operations === 1
    fail(error)
  }
  f.override((command) => {
    if (command.op !== 'browser.action.start') return false
    f.operations.set(3, 102)
    f.sendReady()
    f.reply(command, { id: 101 })
    return true
  })
  try {
    await assert.rejects(f.run(), /Mismatched/)
    assert.equal(failedWithOwner, true)
    assert.equal(f.transport.diagnostics().closed, true)
  } finally {
    await f.stop()
  }
})

test('malformed release ACK closes transport instead of waiting for a removed owner', async () => {
  const f = await fixture()
  f.override((command) => {
    if (command.op !== 'browser.action.release') return false
    f.reply(command, { invalid: true })
    return true
  })
  try {
    const rejected = assert.rejects(f.run(), /Malformed browser release/)
    await turn()
    f.sendReady()
    await rejected
    assert.equal(f.transport.diagnostics().closed, true)
    assert.equal(f.controller.diagnostics.operations, 0)
  } finally {
    await f.stop()
  }
})
