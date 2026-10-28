import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import {
  ParentCloseReceipts,
  parentCloseDocumentTarget,
  parentClosePanes,
  parentCloseUrl,
} from '../examples/view-parent-close/receipts.ts'
import { nativePeer, turn } from './helpers/native-peer.ts'

function prepared() {
  const tracker = new ParentCloseReceipts()
  for (const [index, pane] of parentClosePanes.entries()) {
    const target = 10 + index
    const documentId = `native-${target}-1`
    tracker.observe({
      v: 1,
      event: 'view.loaded',
      target,
      data: { url: parentCloseUrl(pane), documentId, status: 200 },
    })
    tracker.bind(pane, `view-${index}`, `session-${index}`, documentId)
  }
  return tracker
}

test('parent-close receipts require four distinct real loads before the close request', () => {
  const empty = new ParentCloseReceipts()
  assert.throws(() => empty.beginClose())
  assert.throws(() => empty.bind('first', 'view-1', 'session-1', 'native-1-1'))
  const tracker = prepared()
  tracker.beginClose()
  assert.equal(tracker.complete(), false)
  assert.throws(() => tracker.beginClose())
  assert.throws(() => tracker.bind('first', 'view-1', 'session-1', 'native-1-1'))
})

test('native parent close and every exact view callback are independently required', () => {
  const tracker = prepared()
  tracker.beginClose()
  for (const target of [10, 12, 13]) tracker.observe({ v: 1, event: 'view.closed', target })
  assert.equal(tracker.complete(), false)
  tracker.observe({ v: 1, event: 'window.closed', target: 1 })
  assert.equal(tracker.complete(), false)
  tracker.observe({ v: 1, event: 'view.closed', target: 11 })
  assert.equal(tracker.complete(), true)
  assert.equal(tracker.snapshot().nativeViewCloseCallbacks, 4)
  assert.throws(() => tracker.observe({ v: 1, event: 'view.closed', target: 11 }))
  assert.throws(() => tracker.observe({ v: 1, event: 'window.closed', target: 2 }))
})

test('premature, aliased and unrelated close receipts cannot settle the parent', () => {
  const tracker = prepared()
  assert.throws(() => tracker.observe({ v: 1, event: 'view.closed', target: 10 }))
  assert.throws(() => tracker.observe({ v: 1, event: 'window.closed', target: 1 }))
  tracker.beginClose()
  assert.throws(() => tracker.observe({ v: 1, event: 'window.closed', target: 10 }))
  assert.throws(() => tracker.observe({ v: 1, event: 'view.closed', target: 99 }))
  assert.equal(tracker.complete(), false)
})

test('native document binding rejects target swaps, duplicate loads and newline suffixes', () => {
  assert.equal(parentCloseDocumentTarget('native-7-3'), 7)
  for (const document of [
    'native-7-3\n',
    'native-0-3',
    'native-7-0',
    'native-9007199254740992-1',
    'native-7-3-extra',
  ])
    assert.throws(() => parentCloseDocumentTarget(document))
  const tracker = new ParentCloseReceipts()
  const data = { url: parentCloseUrl('first'), documentId: 'native-7-3', status: 200 }
  assert.throws(() => tracker.observe({ v: 1, event: 'view.loaded', target: 8, data }))
  assert.throws(() =>
    tracker.observe({ v: 1, event: 'view.loaded', target: 7, data: { ...data, status: 500 } })
  )
  tracker.observe({ v: 1, event: 'view.loaded', target: 7, data })
  assert.throws(() => tracker.observe({ v: 1, event: 'view.loaded', target: 7, data }))
  assert.throws(() => tracker.bind('first', 'view-1', 'session-1', 'native-7-4'))
})

test('SDK child disposal after a parent reply cannot substitute for native OnBeforeClose receipts', async () => {
  const peer = await nativePeer()
  const backend = new CefBackend(peer.transport)
  const tracker = new ParentCloseReceipts()
  const stop = backend.observe((event) => tracker.observe(event))
  let next = 0
  const targets: number[] = []
  peer.handle((command) => {
    if (command.op.endsWith('.create')) {
      const id = ++next
      peer.reply(command, { id })
      if (command.op === 'view.create') {
        targets.push(id)
        peer.send({
          v: 1,
          event: 'view.loaded',
          target: id,
          data: { url: command.args['url'], documentId: `native-${id}-1`, status: 200 },
        })
      }
    } else {
      peer.reply(command)
      if (command.op === 'window.close')
        peer.send({ v: 1, event: 'window.closed', target: command.args['id'] })
    }
  })
  try {
    const window = await backend.createWindow({
      title: 'Protocol fixture',
      bounds: { x: 0, y: 0, width: 700, height: 550 },
      viewLayout: 'manual',
    })
    for (const pane of parentClosePanes) {
      const session = await backend.createSession({
        persistence: 'ephemeral',
        partition: `parent-${pane}`,
      })
      const view = await backend.createView({
        window,
        session,
        url: parentCloseUrl(pane),
        trust: { kind: 'application', origin: 'app://ui' },
        presentation: { bounds: { x: 0, y: 0, width: 200, height: 150 } },
      })
      await turn()
      tracker.bind(pane, view.id, session.id, backend.state(view).documentId)
    }
    tracker.beginClose()
    await backend.closeWindow(window)
    await turn()
    assert.equal(backend.diagnostics().views, 0)
    assert.equal(tracker.snapshot().nativeViewCloseCallbacks, 0)
    assert.equal(tracker.complete(), false)
    for (const target of targets) peer.send({ v: 1, event: 'view.closed', target })
    await turn()
    assert.equal(tracker.complete(), true)
    assert.equal(backend.diagnostics().listenerErrors, 0)
  } finally {
    stop()
    await peer.stop()
  }
})
