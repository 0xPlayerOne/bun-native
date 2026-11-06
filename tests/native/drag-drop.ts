/**
 * Real drag-and-drop qualification against the native host. An independent OS
 * drag source process (see `drag-source.ts`) starts a platform drag and moves
 * the real pointer over the window: XDND on an isolated X11 display, an
 * AppKit dragging session on macOS, OLE `DoDragDrop` on Windows. Nothing
 * synthesizes a GPUI event. Dropped files live in a private temporary tree;
 * where filesystem grants exist, resolution is checked by reading the
 * resolved path through a real grant.
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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dragBackend,
  dragEnvironment,
  DragSource,
  sourceDescription,
  until as waitUntil,
} from './drag-source.ts'

const { output, host, source, mode } = dragEnvironment()
const backend = dragBackend

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}
const denied = (code: string) => (error: unknown) =>
  error instanceof NativeServiceError && error.service === 'drag_drop' && error.code === code

// Real paths: AppKit and the launch roots must name the same directories.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'bun-native-drop-')))
const work = join(base, 'work')
const docs = join(base, 'docs')
const outside = join(base, 'outside')
for (const directory of [work, docs, outside]) mkdirSync(directory)
writeFileSync(join(work, 'a.txt'), 'alpha')
writeFileSync(join(work, 'b c.txt'), 'bravo')
writeFileSync(join(docs, 'readme.txt'), 'docs')
writeFileSync(join(outside, 'secret'), 'outside')
const many = Array.from({ length: 65 }, (_, index) => join(work, 'f' + index))
for (const path of many) writeFileSync(path, '')
// Launch roots are POSIX paths; no Windows drop can resolve beneath one.
const roots =
  backend === 'ole'
    ? []
    : [
        { id: 'work', path: work, access: 'read' as const },
        { id: 'docs', path: docs, access: 'read' as const },
      ]
const sourceViews: Record<string, unknown> = {}
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

let activeSource: DragSource | undefined

async function until(description: string, predicate: () => boolean): Promise<void> {
  try {
    await waitUntil(description, predicate)
  } catch (error) {
    // The source's own replies tell a drag that never began (pasteboard,
    // mouse-down) from one the host never reported.
    throw new Error(
      (error as Error).message +
        ': ' +
        JSON.stringify(log.slice(-6)) +
        '; source: ' +
        JSON.stringify(activeSource?.recent() ?? [])
    )
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
      backend,
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
    permissions: { dragDrop: 'allow', filesystemRoots: roots },
  })
  const xdnd = new DragSource(source)
  activeSource = xdnd
  let failure: unknown
  try {
    assert.deepEqual(app.serviceCapabilities.dragDrop, {
      availability: 'available',
      permission: 'allow',
      scope: 'owned_target',
      payload: 'files',
      backend,
    })
    const title = 'Bun Native drop qualification'
    const window = await app.openWindow({ title, width: 560, height: 380 })
    const grants = app.serviceCapabilities.filesystemGrants.availability === 'available'
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
    await xdnd.find(title, 560, 380)
    record('ownedTargets', { registered: 3, duplicate: 'conflict' })

    // 1. Accept: a real drop of four files onto the left target.
    let mark = log.length
    const files = [join(work, 'a.txt'), join(work, 'b c.txt'), join(docs, 'readme.txt')]
    await xdnd.offerFiles([...files, join(outside, 'secret')])
    const entered = await xdnd.enter(130, 150)
    // GPUI evaluates drag hover against its last painted frame, and only on
    // pointer motion. Keep moving until the newly registered targets' frame
    // has been painted, as a real drag would.
    for (let step = 1; log.length === mark && step <= 40; step++) {
      await Bun.sleep(25)
      await xdnd.move(130 + (step % 2), 150 + (step % 2))
    }
    await until('left drag entry', () => log.length > mark)
    assert.deepEqual(log.slice(mark), [{ target: 'left', type: 'drag_entered' }])
    await xdnd.move(140, 160)
    sourceViews['acceptedDrop'] = await xdnd.drop()
    await until('left drop', () => drops.has('left'))
    assert.deepEqual(await since(mark), [
      { target: 'left', type: 'drag_entered' },
      { target: 'left', type: 'drop', detail: ['a.txt', 'b c.txt', 'readme.txt', 'secret'] },
    ])
    assert.deepEqual(pointerEvents, [])
    record('acceptedDrop', { source: entered, items: 4, pointerEvents: pointerEvents.length })

    // Names are display data; only the host maps an item beneath a launch root.
    const items = drops.get('left')!.items
    await assert.rejects(items[0]!.resolve('other'), denied('permission_denied'))
    await assert.rejects(items[0]!.resolve('../work'), TypeError)
    if (backend === 'ole') {
      // No POSIX launch root can be declared, so no item resolves.
      await assert.rejects(items[0]!.resolve('work'), denied('permission_denied'))
      record('explicitResolution', { roots: 0, work: 'permission_denied' })
    } else {
      const first = await items[0]!.resolve('work')
      assert.deepEqual(first, { root: 'work', path: 'a.txt' })
      assert.deepEqual(await items[1]!.resolve('work'), { root: 'work', path: 'b c.txt' })
      assert.deepEqual(await items[2]!.resolve('docs'), { root: 'docs', path: 'readme.txt' })
      await assert.rejects(items[2]!.resolve('work'), denied('path_denied'))
      await assert.rejects(items[3]!.resolve('work'), denied('path_denied'))
      await assert.rejects(items[3]!.resolve('docs'), denied('path_denied'))
      let grantRead = 'unavailable'
      if (grants) {
        const grant = await window.openFileGrant(first.root)
        grantRead = new TextDecoder().decode((await grant.read(first.path)).bytes)
        assert.equal(grantRead, 'alpha')
        await grant.close()
      } else
        await assert.rejects(
          window.openFileGrant(first.root),
          (error: unknown) =>
            error instanceof NativeServiceError &&
            error.service === 'filesystem_grants' &&
            error.code === 'service_unavailable'
        )
      record('explicitResolution', {
        work: ['a.txt', 'b c.txt'],
        docs: 'readme.txt',
        outside: 'path_denied',
        grantRead,
      })
    }

    // 2. Cancel by moving off the target, then the source leaves.
    mark = log.length
    await xdnd.offerFiles([join(work, 'a.txt')])
    await xdnd.enter(130, 150)
    await until('drag entry', () => log.length > mark)
    await xdnd.move(540, 300)
    await until('drag exit', () => log.length > mark + 1)
    await xdnd.leave()
    assert.deepEqual(await since(mark), [
      { target: 'left', type: 'drag_entered' },
      { target: 'left', type: 'drag_left' },
    ])
    // 3. The source cancels (XdndLeave) while over the target.
    mark = log.length
    await xdnd.enter(130, 150)
    await until('drag entry', () => log.length > mark)
    await xdnd.leave()
    assert.deepEqual(await since(mark), [
      { target: 'left', type: 'drag_entered' },
      { target: 'left', type: 'drag_left' },
    ])
    // 4. Dropping on bare root delivers nothing; GPUI still reports a copy.
    mark = log.length
    await xdnd.enter(540, 300)
    sourceViews['bareDrop'] = await xdnd.drop()
    assert.deepEqual(await since(mark), [])
    record('cancellation', { movedOff: 'drag_left', sourceLeave: 'drag_left', bareDrop: 'none' })

    // 5. Nested targets: hit testing gives the drop to the innermost target.
    mark = log.length
    drops.clear()
    await xdnd.enter(320, 60)
    await until('nested entry', () => log.length >= mark + 2)
    await xdnd.drop()
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
    // GPUI's X11 target turns plain text into an empty file drag. Its AppKit
    // and OLE targets start no GPUI drag for a drag without files, and the
    // release they still synthesize is not reported as a pointer event.
    mark = log.length
    await xdnd.offerText('plain text, not a file')
    await xdnd.enter(130, 150)
    if (backend === 'x11') await until('text entry', () => log.length > mark)
    sourceViews['textDrop'] = await xdnd.drop()
    if (backend === 'x11') await until('text rejection', () => log.length > mark + 1)
    const text = await since(mark)
    assert.deepEqual(
      text,
      backend === 'x11'
        ? [
            { target: 'left', type: 'drag_entered' },
            { target: 'left', type: 'drop_rejected', detail: 'empty' },
          ]
        : []
    )
    assert.deepEqual(pointerEvents, [])
    mark = log.length
    await xdnd.offerFiles(many)
    const largeListEntry = await xdnd.enter(130, 150)
    try {
      await until('list entry', () => log.length > mark)
    } catch (error) {
      if (backend === 'appkit') {
        // The independent source reported a screen point but the host did
        // not report an entry. Re-read the same owned WindowServer window
        // after the original failure to distinguish target movement from a
        // missing native drag event. Never replace the first failure.
        const currentWindow = await xdnd
          .send('find ' + JSON.stringify({ title, width: 560, height: 380, pid: process.pid }))
          .catch((lookupError: unknown) => ({ lookupError: String(lookupError) }))
        const failedAt = performance.now()
        // Measured: a healthy runner delivers this entry in 0.9-1.5 s for 65
        // files and 0.4-0.6 s for one. Keep watching after the failure (the
        // original error is still thrown) so a late entry is told apart from
        // a missing one.
        let lateEntryMs: number | null = null
        while (performance.now() - failedAt < 10_000) {
          if (log.length > mark) {
            lateEntryMs = Math.round(performance.now() - failedAt)
            break
          }
          await Bun.sleep(25)
        }
        console.error(
          'AppKit large-list entry evidence:',
          JSON.stringify({
            sourceEntry: largeListEntry,
            lateEntryMs,
            currentWindow,
            activeTargets: [left.active, right.active, inner.active],
          }).slice(0, 2_000)
        )
      }
      throw error
    }
    await xdnd.drop()
    assert.deepEqual(await since(mark), [
      { target: 'left', type: 'drag_entered' },
      { target: 'left', type: 'drop_rejected', detail: 'limit_exceeded' },
    ])
    // A newer drop on the same target replaces the retained paths.
    await assert.rejects(items[0]!.resolve('work'), denied('cancelled'))
    record('typedRejections', {
      text: backend === 'x11' ? 'empty' : 'not delivered',
      items65: 'limit_exceeded',
      replaced: 'cancelled',
    })

    // 7. Disposal during a drag: closing the target mid-drag delivers nothing.
    await xdnd.offerFiles([join(work, 'a.txt')])
    mark = log.length
    await xdnd.enter(130, 150)
    await until('drag entry', () => log.length > mark)
    await left.close()
    assert.equal(left.active, false)
    await xdnd.drop()
    assert.deepEqual(await since(mark), [{ target: 'left', type: 'drag_entered' }])
    await left.close() // Idempotent.

    // Removing a target's node mid-drag revokes it; the drop falls to its parent.
    mark = log.length
    drops.clear()
    await xdnd.enter(320, 60)
    await until('nested entry', () => log.length >= mark + 2)
    await window.batch((batch) => batch.remove(nodes.inner))
    assert.equal(inner.active, false)
    await xdnd.move(321, 61)
    await xdnd.drop()
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
    await xdnd.find('Bun Native drop closing', 300, 200)
    await xdnd.enter(100, 100)
    for (let step = 1; closingEvents === 0 && step <= 40; step++) {
      await Bun.sleep(25)
      await xdnd.move(100 + (step % 2), 100 + (step % 2))
    }
    await until('closing entry', () => closingEvents === 1)
    await closing.close()
    assert.equal(closingTarget.active, false)
    // XDND still addresses the closed window. AppKit and OLE would deliver to
    // whatever lies beneath the pointer now, so their source cancels instead.
    // X11's reply is unchecked: GPUI no longer answers for the closed window.
    const late = backend === 'x11' ? await xdnd.send('drop') : await xdnd.leave()
    await Bun.sleep(150)
    assert.equal(closingEvents, 1)
    record('windowCloseDuringDrag', { lateEvents: closingEvents - 1, sourceFinished: late })

    await xdnd.find(title, 560, 380)
    mark = log.length
    if (backend === 'x11') {
      // The pinned GPUI X11 backend keeps one XDND state per connection and
      // resets it only on a Leave or Drop that reaches a live window. After
      // the owner closed mid-drag, the next drag is never converted, so GPUI
      // starts no drag and nothing is delivered; its Leave resets the backend.
      assert.deepEqual(await xdnd.send('enter 400 250'), {
        status: { accepted: true, copy: true },
        conversions: 0,
      })
      assert.deepEqual(await xdnd.send('leave'), { left: true })
      assert.deepEqual(await since(mark), [])
      record('backendStaleAfterClose', { nextDragConversions: 0, delivered: 0 })
    }

    // The application and remaining target are healthy again afterwards.
    mark = log.length
    await xdnd.enter(400, 250)
    await until('healthy entry', () => log.length > mark)
    await xdnd.leave()
    await until('healthy exit', () => log.length > mark + 1)
    assert.deepEqual(pointerEvents, [])
    await right.close()
    return [left, right, inner] as NativeDropTarget[]
  } catch (error) {
    failure = error
    throw error
  } finally {
    // A failed run still reports its own error first: a source that exited
    // because of it must not replace that error with its exit status.
    const cleanup = async () => {
      await xdnd.close()
      await app.shutdown()
      await app.closed
      assert.deepEqual(Object.values(app.diagnostics), [0, 0, 0, 0, 0, 0, 0])
    }
    if (failure === undefined) await cleanup()
    else await cleanup().catch((error: unknown) => console.error('cleanup after failure:', error))
  }
}

/** Raw protocol checks: the host itself rejects foreign, stale and unknown handles. */
async function rawHandles() {
  const native = await NativeHost.launch({
    executable: host,
    permissions: { dragDrop: 'allow', filesystemRoots: roots.slice(0, 1) },
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
      // Without a declared root (Windows), the root check comes first.
      unknownDrop: backend === 'ole' ? 'permission_denied' : 'invalid_handle',
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
      schemaVersion: 2,
      mode,
      backend,
      platform: process.platform,
      bun: process.versions.bun,
      revision: Bun.revision,
      display:
        backend === 'x11' ? 'isolated Xvfb with openbox' : 'hosted runner interactive session',
      source: sourceDescription[backend],
      // GPUI answers every converted drag with copy; recorded, never asserted
      // beyond X11, where the source protocol reply is checked exactly.
      sourceViews,
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log('Drag and drop qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
