/**
 * One real drag-and-drop oracle shared by the Solid and React fixtures. The
 * independent OS drag source (`drag-source.ts`) performs every drag; the frameworks
 * only mount, register through their public `registerDropTarget` export and
 * unmount the zone in the middle of a drag.
 */
import {
  createApplication,
  NativeServiceError,
  type DropTargetEvent,
  type NativeDropTarget,
  type NativeWindow,
} from '@bun-native/core'
import type { RenderRoot } from '@bun-native/renderer'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dragBackend, dragEnvironment, DragSource, until } from './drag-source.ts'

export type DropAdapterMount = (
  window: NativeWindow,
  ownerDisposed: () => void
) => {
  view: RenderRoot
  /** Register the mounted zone through the framework's own export. */
  register(listener: (event: DropTargetEvent) => void): Promise<NativeDropTarget>
  /** Whether the framework currently holds a reference to a mounted zone. */
  mounted(): boolean
  /** Mount or unmount the zone through framework state. */
  show(visible: boolean): void
}

export async function runDropAdapter(
  framework: 'solid' | 'react',
  mount: DropAdapterMount
): Promise<void> {
  const { output, host: executable, source, mode } = dragEnvironment()
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'bun-native-drop-' + framework + '-')))
  const work = join(base, 'work')
  mkdirSync(work)
  writeFileSync(join(work, 'a.txt'), 'alpha')
  const log: { type: DropTargetEvent['type']; detail?: unknown }[] = []
  const events: DropTargetEvent[] = []
  const listener = (event: DropTargetEvent) => {
    events.push(event)
    log.push(
      event.type === 'drop'
        ? { type: 'drop', detail: event.items.map((item) => item.name) }
        : { type: event.type }
    )
  }
  const since = async (mark: number) => {
    await Bun.sleep(150)
    return log.slice(mark)
  }
  const outcomes: Record<string, unknown> = {}
  let ownerDisposals = 0
  let view: RenderRoot | undefined
  const app = await createApplication({
    executable,
    permissions: {
      dragDrop: 'allow',
      // Launch roots are POSIX paths; none can be declared on Windows.
      filesystemRoots: dragBackend === 'ole' ? [] : [{ id: 'work', path: work, access: 'read' }],
    },
  })
  const xdnd = new DragSource(source)
  try {
    const title = `Bun Native ${framework} drop`
    const window = await app.openWindow({ title, width: 560, height: 380 })
    const mounted = mount(window, () => ownerDisposals++)
    view = mounted.view
    await view.ready
    assert.equal(mounted.mounted(), true)
    const first = await mounted.register(listener)
    await xdnd.find(title, 560, 380)

    // A real drop through the adapter-registered target, then explicit resolution.
    await xdnd.offerFiles([join(work, 'a.txt')])
    let mark = log.length
    await xdnd.enter(130, 150)
    // As below: hover needs a painted frame holding the registered element.
    for (let step = 1; log.length === mark && step <= 40; step++) {
      await Bun.sleep(25)
      await xdnd.move(130 + (step % 2), 150 + (step % 2))
    }
    await until('adapter drag entry', () => log.length > mark)
    await xdnd.drop()
    await until('adapter drop', () => log.length > mark + 1)
    assert.deepEqual(await since(mark), [
      { type: 'drag_entered' },
      { type: 'drop', detail: ['a.txt'] },
    ])
    const drop = events.at(-1)
    assert(drop?.type === 'drop')
    assert.equal(drop.target, first)
    if (dragBackend === 'ole') {
      await assert.rejects(
        drop.items[0]!.resolve('work'),
        (error: unknown) =>
          error instanceof NativeServiceError && error.code === 'permission_denied'
      )
      outcomes['adapterDrop'] = { items: ['a.txt'], resolved: 'permission_denied' }
    } else {
      const resolved = await drop.items[0]!.resolve('work')
      assert.deepEqual(resolved, { root: 'work', path: 'a.txt' })
      let grantRead = 'unavailable'
      if (app.serviceCapabilities.filesystemGrants.availability === 'available') {
        const grant = await window.openFileGrant(resolved.root)
        grantRead = new TextDecoder().decode((await grant.read(resolved.path)).bytes)
        assert.equal(grantRead, 'alpha')
        await grant.close()
      }
      outcomes['adapterDrop'] = { items: ['a.txt'], resolved, grantRead }
    }

    // Unmounting the zone through framework state mid-drag revokes the target.
    mark = log.length
    await xdnd.enter(130, 150)
    await until('drag entry before unmount', () => log.length > mark)
    const entered = events.at(-1)!
    mounted.show(false)
    await view.flush()
    assert.equal(mounted.mounted(), false)
    assert.equal(first.active, false)
    assert.equal(entered.signal.aborted, true)
    await xdnd.move(131, 151)
    await xdnd.drop()
    assert.deepEqual(await since(mark), [{ type: 'drag_entered' }])
    await assert.rejects(
      drop.items[0]!.resolve('work'),
      (error: unknown) => error instanceof NativeServiceError && error.code === 'cancelled'
    )
    outcomes['unmountDuringDrag'] = { lateEvents: 0, staleItem: 'cancelled' }

    // Remounting yields a fresh element that registers and hovers normally.
    mounted.show(true)
    await view.flush()
    assert.equal(mounted.mounted(), true)
    const second = await mounted.register(listener)
    mark = log.length
    await xdnd.enter(130, 150)
    // GPUI evaluates drag hover against its last painted frame, and only on
    // pointer motion. Like any real drag, keep moving until a frame that
    // contains the freshly registered element has been painted.
    for (let step = 1; log.length === mark && step <= 40; step++) {
      await Bun.sleep(25)
      await xdnd.move(130 + (step % 2), 150 + (step % 2))
    }
    await until('remounted entry', () => log.length > mark)
    await xdnd.leave()
    await until('remounted exit', () => log.length > mark + 1)
    assert.deepEqual(await since(mark), [{ type: 'drag_entered' }, { type: 'drag_left' }])
    assert.notEqual(second, first)

    // Disposing the whole view revokes the remaining adapter target.
    await view.dispose()
    assert.equal(second.active, false)
    assert.equal(ownerDisposals, 1)
    assert.equal(view.diagnostics.nodes, 0)
    assert.equal(view.diagnostics.listeners, 0)
    mark = log.length
    await xdnd.enter(130, 150)
    await xdnd.drop()
    assert.deepEqual(await since(mark), [])
    outcomes['disposeRevokes'] = { remounted: ['drag_entered', 'drag_left'], afterDispose: 0 }
  } finally {
    await xdnd.close()
    await view?.dispose()
    await app.shutdown()
    await app.closed
    rmSync(base, { recursive: true, force: true })
  }
  assert(Object.values(app.diagnostics).every((count) => count === 0))
  writeFileSync(
    join(output, `${framework}-drag-drop.json`),
    JSON.stringify(
      {
        status: 'passed',
        framework,
        mode,
        backend: dragBackend,
        outcomes,
        ownership: app.diagnostics,
      },
      null,
      2
    ) + '\n'
  )
  console.log(`${framework} drag and drop adapter passed`)
}
