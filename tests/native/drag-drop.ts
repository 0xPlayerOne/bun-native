/**
 * Real drag-and-drop qualification against the native host on an isolated
 * X11 display. An independent XDND source process (`xdnd-source`) grabs the
 * pointer, warps it over the window and speaks XDND to GPUI's own X11 target
 * code, answering the selection conversion itself. Nothing synthesizes a GPUI
 * event. Dropped files live in a private temporary tree; resolution is checked
 * by reading the resolved path through a real filesystem grant.
 */
import {
  createApplication,
  NativeServiceError,
  type DropTargetEvent,
  type NativeDropTarget,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'
import { NativeCommandError, NativeHost } from '@bun-native/runtime'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { accepted, until as waitUntil, uris, XdndSource } from './xdnd-source.ts'

const output = process.env['BUN_NATIVE_DRAG_DROP_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const peer = process.env['BUN_NATIVE_XDND_SOURCE']
const mode = process.env['BUN_NATIVE_DRAG_DROP_MODE']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  !peer ||
  !isAbsolute(peer) ||
  (mode !== 'development' && mode !== 'aot') ||
  !process.env['DISPLAY'] ||
  process.env['WAYLAND_DISPLAY']
)
  throw new Error(
    'An isolated X11 display, evidence directory, host, XDND source and mode are required'
  )
const host = executable
const source = peer

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}
const denied = (code: string) => (error: unknown) =>
  error instanceof NativeServiceError && error.service === 'drag_drop' && error.code === code

const base = mkdtempSync(join(tmpdir(), 'bun-native-drop-'))
const work = join(base, 'work')
const docs = join(base, 'docs')
const outside = join(base, 'outside')
for (const directory of [work, docs, outside]) mkdirSync(directory)
writeFileSync(join(work, 'a.txt'), 'alpha')
writeFileSync(join(work, 'b c.txt'), 'bravo')
writeFileSync(join(docs, 'readme.txt'), 'docs')
writeFileSync(join(outside, 'secret'), 'outside')
type Logged = { target: string; type: DropTargetEvent['type']; detail?: unknown }
const log: Logged[] = []
const drops = new Map<string, Extract<DropTargetEvent, { type: 'drop' }>>()

function listener(name: string) {
  return (event: DropTargetEvent) => {
    if (event.type === 'drop') {
      drops.set(name, event)
      log.push({ target: name, type: 'drop', detail: event.items.map((item) => item.name) })
    } else if (event.type === 'drop_rejected')
      log.push({ target: name, type: event.type, detail: event.reason })
    else log.push({ target: name, type: event.type })
  }
}

async function until(description: string, predicate: () => boolean): Promise<void> {
  try {
    await waitUntil(description, predicate)
  } catch (error) {
    throw new Error((error as Error).message + ': ' + JSON.stringify(log.slice(-6)))
  }
}

/** Every event the host delivered since `mark`, after a short quiet period. */
async function since(mark: number): Promise<Logged[]> {
  await Bun.sleep(150)
  return log.slice(mark)
}

async function deniedByDefault() {
  const app = await createApplication({ executable: host })
  try {
    assert.deepEqual(app.serviceCapabilities.dragDrop, {
      availability: 'available',
      permission: 'deny',
      scope: 'owned_target',
      payload: 'files',
      backend: 'x11',
    })
    const window = await app.openWindow({ title: 'Drop denial' })
    await assert.rejects(
      window.registerDropTarget(window.root, () => {}),
      denied('permission_denied')
    )
    record('nativeDefaultDenial', { code: 'permission_denied' })
  } finally {
    await app.shutdown()
    await app.closed
  }
}

interface Layout {
  left: NativeNode<'box'>
  right: NativeNode<'box'>
  inner: NativeNode<'box'>
}

function layout(window: NativeWindow): Promise<Layout> {
  // Window-relative regions: left 0..260, right 260..520 holding inner at
  // 260..380 x 0..120, all 340 high, and bare root beyond 520.
  return window.batch((batch) => {
    batch.set(window.root, { kind: 'box', style: { direction: 'row' } })
    const left = batch.create({ kind: 'box', style: { width: 260, height: 340 } })
    const right = batch.create({ kind: 'box', style: { width: 260, height: 340 } })
    const inner = batch.create({ kind: 'box', style: { width: 120, height: 120 } })
    batch.append(window.root, left)
    batch.append(window.root, right)
    batch.append(right, inner)
    return { left, right, inner }
  })
}

async function qualification() {
  const app = await createApplication({
    executable: host,
    permissions: {
      dragDrop: 'allow',
      filesystemRoots: [
        { id: 'work', path: work, access: 'read' },
        { id: 'docs', path: docs, access: 'read' },
      ],
    },
  })
  const xdnd = new XdndSource(source)
  try {
    assert.deepEqual(app.serviceCapabilities.dragDrop, {
      availability: 'available',
      permission: 'allow',
      scope: 'owned_target',
      payload: 'files',
      backend: 'x11',
    })
    const title = 'Bun Native drop qualification'
    const window = await app.openWindow({ title, width: 560, height: 380 })
    const nodes = await layout(window)
    const pointerEvents: string[] = []
    window.on(window.root, 'pointer_down', () => void pointerEvents.push('down'), { capture: true })
    window.on(window.root, 'pointer_up', () => void pointerEvents.push('up'), { capture: true })
    const left = await window.registerDropTarget(nodes.left, listener('left'))
    const right = await window.registerDropTarget(nodes.right, listener('right'))
    const inner = await window.registerDropTarget(nodes.inner, listener('inner'))
    await assert.rejects(
      window.registerDropTarget(nodes.left, () => {}),
      denied('conflict')
    )
    assert.deepEqual(await xdnd.send('find ' + title), { found: true })
    record('ownedTargets', { registered: 3, duplicate: 'conflict' })

    // 1. Accept: a real drop of four files onto the left target.
    let mark = log.length
    const files = [join(work, 'a.txt'), join(work, 'b c.txt'), join(docs, 'readme.txt')]
    await xdnd.send('offer uri ' + JSON.stringify(uris(...files, join(outside, 'secret'))))
    const entered = await xdnd.send('enter 130 150')
    assert.deepEqual(entered, { status: accepted, conversions: 1 })
    await until('left drag entry', () => log.length > mark)
    assert.deepEqual(log.slice(mark), [{ target: 'left', type: 'drag_entered' }])
    assert.deepEqual(await xdnd.send('move 140 160'), { status: accepted, conversions: 1 })
    assert.deepEqual(await xdnd.send('drop'), { finished: accepted })
    await until('left drop', () => drops.has('left'))
    assert.deepEqual(await since(mark), [
      { target: 'left', type: 'drag_entered' },
      { target: 'left', type: 'drop', detail: ['a.txt', 'b c.txt', 'readme.txt', 'secret'] },
    ])
    assert.deepEqual(pointerEvents, [])
    record('acceptedDrop', { source: entered, items: 4, pointerEvents: pointerEvents.length })

    // Names are display data; only the host maps an item beneath a launch root.
    const items = drops.get('left')!.items
    const first = await items[0]!.resolve('work')
    assert.deepEqual(first, { root: 'work', path: 'a.txt' })
    assert.deepEqual(await items[1]!.resolve('work'), { root: 'work', path: 'b c.txt' })
    assert.deepEqual(await items[2]!.resolve('docs'), { root: 'docs', path: 'readme.txt' })
    await assert.rejects(items[2]!.resolve('work'), denied('path_denied'))
    await assert.rejects(items[3]!.resolve('work'), denied('path_denied'))
    await assert.rejects(items[3]!.resolve('docs'), denied('path_denied'))
    await assert.rejects(items[0]!.resolve('other'), denied('permission_denied'))
    await assert.rejects(items[0]!.resolve('../work'), TypeError)
    const grant = await window.openFileGrant(first.root)
    assert.equal(new TextDecoder().decode((await grant.read(first.path)).bytes), 'alpha')
    await grant.close()
    record('explicitResolution', {
      work: ['a.txt', 'b c.txt'],
      docs: 'readme.txt',
      outside: 'path_denied',
      grantRead: 'alpha',
    })

    // 2. Cancel by moving off the target, then the source leaves.
    mark = log.length
    await xdnd.send('offer uri ' + JSON.stringify(uris(join(work, 'a.txt'))))
    assert.deepEqual(await xdnd.send('enter 130 150'), { status: accepted, conversions: 1 })
    await until('drag entry', () => log.length > mark)
    assert.deepEqual(await xdnd.send('move 540 300'), { status: accepted, conversions: 1 })
    await until('drag exit', () => log.length > mark + 1)
    assert.deepEqual(await xdnd.send('leave'), { left: true })
    assert.deepEqual(await since(mark), [
      { target: 'left', type: 'drag_entered' },
      { target: 'left', type: 'drag_left' },
    ])
    // 3. The source cancels (XdndLeave) while over the target.
    mark = log.length
    assert.deepEqual(await xdnd.send('enter 130 150'), { status: accepted, conversions: 1 })
    await until('drag entry', () => log.length > mark)
    assert.deepEqual(await xdnd.send('leave'), { left: true })
    assert.deepEqual(await since(mark), [
      { target: 'left', type: 'drag_entered' },
      { target: 'left', type: 'drag_left' },
    ])
    // 4. Dropping on bare root delivers nothing; GPUI still reports a copy.
    mark = log.length
    assert.deepEqual(await xdnd.send('enter 540 300'), { status: accepted, conversions: 1 })
    assert.deepEqual(await xdnd.send('drop'), { finished: accepted })
    assert.deepEqual(await since(mark), [])
    record('cancellation', { movedOff: 'drag_left', sourceLeave: 'drag_left', bareDrop: 'none' })

    // 5. Nested targets: hit testing gives the drop to the innermost target.
    mark = log.length
    drops.clear()
    assert.deepEqual(await xdnd.send('enter 320 60'), { status: accepted, conversions: 1 })
    await until('nested entry', () => log.length >= mark + 2)
    assert.deepEqual(await xdnd.send('drop'), { finished: accepted })
    await until('nested drop', () => drops.has('inner'))
    const nested = await since(mark)
    assert.deepEqual(
      nested.filter((entry) => entry.type === 'drop'),
      [{ target: 'inner', type: 'drop', detail: ['a.txt'] }]
    )
    assert.deepEqual(
      nested.filter((entry) => entry.target === 'right').map((entry) => entry.type),
      ['drag_entered', 'drag_left']
    )
    record('nestedHitTest', { drop: 'inner', outer: ['drag_entered', 'drag_left'] })

    // 6. Untyped text and oversized lists are typed rejections, not data.
    mark = log.length
    await xdnd.send('offer text ' + JSON.stringify('plain text, not a file'))
    assert.deepEqual(await xdnd.send('enter 130 150'), { status: accepted, conversions: 1 })
    await until('text entry', () => log.length > mark)
    assert.deepEqual(await xdnd.send('drop'), { finished: accepted })
    await until('text rejection', () => log.length > mark + 1)
    const many = Array.from({ length: 65 }, (_, index) => join(work, 'f' + index))
    await xdnd.send('offer uri ' + JSON.stringify(uris(...many)))
    assert.deepEqual(await xdnd.send('enter 130 150'), { status: accepted, conversions: 1 })
    await until('list entry', () => log.length > mark + 2)
    assert.deepEqual(await xdnd.send('drop'), { finished: accepted })
    assert.deepEqual(await since(mark), [
      { target: 'left', type: 'drag_entered' },
      { target: 'left', type: 'drop_rejected', detail: 'empty' },
      { target: 'left', type: 'drag_entered' },
      { target: 'left', type: 'drop_rejected', detail: 'limit_exceeded' },
    ])
    // A newer drop on the same target replaces the retained paths.
    await assert.rejects(items[0]!.resolve('work'), denied('cancelled'))
    record('typedRejections', { text: 'empty', items65: 'limit_exceeded', replaced: 'cancelled' })

    // 7. Disposal during a drag: closing the target mid-drag delivers nothing.
    await xdnd.send('offer uri ' + JSON.stringify(uris(join(work, 'a.txt'))))
    mark = log.length
    assert.deepEqual(await xdnd.send('enter 130 150'), { status: accepted, conversions: 1 })
    await until('drag entry', () => log.length > mark)
    await left.close()
    assert.equal(left.active, false)
    assert.deepEqual(await xdnd.send('drop'), { finished: accepted })
    assert.deepEqual(await since(mark), [{ target: 'left', type: 'drag_entered' }])
    await left.close() // Idempotent.

    // Removing a target's node mid-drag revokes it; the drop falls to its parent.
    mark = log.length
    drops.clear()
    assert.deepEqual(await xdnd.send('enter 320 60'), { status: accepted, conversions: 1 })
    await until('nested entry', () => log.length >= mark + 2)
    await window.batch((batch) => batch.remove(nodes.inner))
    assert.equal(inner.active, false)
    assert.deepEqual(await xdnd.send('move 321 61'), { status: accepted, conversions: 1 })
    assert.deepEqual(await xdnd.send('drop'), { finished: accepted })
    await until('parent drop', () => drops.has('right'))
    const removed = await since(mark)
    assert.deepEqual(
      removed.filter((entry) => entry.target === 'inner').map((entry) => entry.type),
      ['drag_entered']
    )
    assert.deepEqual(
      removed.filter((entry) => entry.target === 'right').map((entry) => entry.type),
      ['drag_entered', 'drop']
    )
    record('disposalDuringDrag', { closedTarget: 'none', removedNode: 'none', parent: 'drop' })

    // 8. Window close during a drag: no late event; GPUI no longer answers.
    const closing = await app.openWindow({
      title: 'Bun Native drop closing',
      width: 300,
      height: 200,
    })
    let closingEvents = 0
    const closingTarget = await closing.registerDropTarget(closing.root, () => void closingEvents++)
    assert.deepEqual(await xdnd.send('find Bun Native drop closing'), { found: true })
    assert.deepEqual(await xdnd.send('enter 100 100'), { status: accepted, conversions: 1 })
    await until('closing entry', () => closingEvents === 1)
    await closing.close()
    assert.equal(closingTarget.active, false)
    const late = await xdnd.send('drop')
    await Bun.sleep(150)
    assert.equal(closingEvents, 1)
    record('windowCloseDuringDrag', { lateEvents: closingEvents - 1, sourceFinished: late })

    // The pinned GPUI X11 backend keeps one XDND state per connection and
    // resets it only on a Leave or Drop that reaches a live window. After the
    // owner closed mid-drag, the next drag is never converted, so GPUI starts
    // no drag and nothing is delivered; its Leave resets the backend.
    await xdnd.send('find ' + title)
    mark = log.length
    assert.deepEqual(await xdnd.send('enter 400 250'), { status: accepted, conversions: 0 })
    assert.deepEqual(await xdnd.send('leave'), { left: true })
    assert.deepEqual(await since(mark), [])
    record('backendStaleAfterClose', { nextDragConversions: 0, delivered: 0 })

    // The application and remaining target are healthy again afterwards.
    assert.deepEqual(await xdnd.send('enter 400 250'), { status: accepted, conversions: 1 })
    await until('healthy entry', () => log.length > mark)
    assert.deepEqual(await xdnd.send('leave'), { left: true })
    await until('healthy exit', () => log.length > mark + 1)
    assert.deepEqual(pointerEvents, [])
    await right.close()
    return [left, right, inner] as NativeDropTarget[]
  } finally {
    await xdnd.close()
    await app.shutdown()
    await app.closed
    assert.deepEqual(Object.values(app.diagnostics), [0, 0, 0, 0, 0, 0, 0])
  }
}

/** Raw protocol checks: the host itself rejects foreign, stale and unknown handles. */
async function rawHandles() {
  const native = await NativeHost.launch({
    executable: host,
    permissions: {
      dragDrop: 'allow',
      filesystemRoots: [{ id: 'work', path: work, access: 'read' }],
    },
  })
  const code = (operation: Promise<unknown>) =>
    operation.then(
      () => 'accepted',
      (error: unknown) => (error instanceof NativeCommandError ? error.code : String(error))
    )
  try {
    for (const id of [1, 2])
      await native.send({
        type: 'open',
        window_id: id,
        root_id: id,
        title: 'Raw ' + id,
        width: 200,
        height: 120,
      })
    const register = (window_id: number, target_id: number, node_id: number) =>
      native.send({ type: 'register_drop_target', window_id, target_id, node_id })
    const results = {
      registered: await code(register(1, 5, 1)),
      uncommittedNode: await code(register(1, 6, 9)),
      foreignNode: await code(register(1, 7, 2)),
      reusedId: await code(register(2, 5, 2)),
      lowerId: await code(register(2, 4, 2)),
      foreignUnregister: await code(
        native.send({ type: 'unregister_drop_target', window_id: 2, target_id: 5 })
      ),
      unknownDrop: await code(
        native.send({
          type: 'resolve_dropped_item',
          window_id: 1,
          target_id: 5,
          drop_id: 1,
          item: 0,
          root: 'work',
        })
      ),
      ungrantedRoot: await code(
        native.send({
          type: 'resolve_dropped_item',
          window_id: 1,
          target_id: 5,
          drop_id: 1,
          item: 0,
          root: 'docs',
        })
      ),
    }
    await native.send({ type: 'unregister_drop_target', window_id: 1, target_id: 5 })
    Object.assign(results, {
      staleUnregister: await code(
        native.send({ type: 'unregister_drop_target', window_id: 1, target_id: 5 })
      ),
    })
    assert.deepEqual(results, {
      registered: 'accepted',
      uncommittedNode: 'invalid_handle',
      foreignNode: 'invalid_handle',
      reusedId: 'invalid_handle',
      lowerId: 'invalid_handle',
      foreignUnregister: 'invalid_handle',
      unknownDrop: 'invalid_handle',
      ungrantedRoot: 'permission_denied',
      staleUnregister: 'invalid_handle',
    })
    record('nativeHandleChecks', results)
  } finally {
    await native.shutdown()
  }
}

try {
  await deniedByDefault()
  const targets = await qualification()
  assert.deepEqual(
    targets.map((target) => target.active),
    [false, false, false]
  )
  record('shutdownRevokes', { active: 0 })
  await rawHandles()
} finally {
  rmSync(base, { recursive: true, force: true })
}

writeFileSync(
  join(output, 'drag-drop.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      display: 'isolated Xvfb with openbox',
      source: 'independent x11rb XDND v5 source process (xdnd-source), pointer grab and warp',
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log('Drag and drop qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
