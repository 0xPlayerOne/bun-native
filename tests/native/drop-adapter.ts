/**
 * One real drag-and-drop oracle shared by the Solid and React fixtures. The
 * independent `xdnd-source` X11 client performs every drag; the frameworks
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
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { accepted, until, uris, XdndSource } from './xdnd-source.ts'

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
  const output = process.env['BUN_NATIVE_DRAG_DROP_EVIDENCE']
  const executable = process.env['BUN_NATIVE_HOST']
  const source = process.env['BUN_NATIVE_XDND_SOURCE']
  const mode = process.env['BUN_NATIVE_DRAG_DROP_MODE']
  if (
    !output ||
    !isAbsolute(output) ||
    !statSync(output).isDirectory() ||
    !executable ||
    !isAbsolute(executable) ||
    !source ||
    !isAbsolute(source) ||
    (mode !== 'development' && mode !== 'aot') ||
    !process.env['DISPLAY'] ||
    process.env['WAYLAND_DISPLAY']
  )
    throw new Error(
      'An isolated X11 display, evidence directory, host, XDND source and mode are required'
    )

  const base = mkdtempSync(join(tmpdir(), 'bun-native-drop-' + framework + '-'))
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
      filesystemRoots: [{ id: 'work', path: work, access: 'read' }],
    },
  })
  const xdnd = new XdndSource(source)
  try {
    const title = `Bun Native ${framework} drop`
    const window = await app.openWindow({ title, width: 560, height: 380 })
    const mounted = mount(window, () => ownerDisposals++)
    view = mounted.view
    await view.ready
    assert.equal(mounted.mounted(), true)
    const first = await mounted.register(listener)
    assert.deepEqual(await xdnd.send('find ' + title), { found: true })

    // A real drop through the adapter-registered target, then explicit resolution.
    await xdnd.send('offer uri ' + JSON.stringify(uris(join(work, 'a.txt'))))
    let mark = log.length
    assert.deepEqual(await xdnd.send('enter 130 150'), { status: accepted, conversions: 1 })
    await until('adapter drag entry', () => log.length > mark)
    assert.deepEqual(await xdnd.send('drop'), { finished: accepted })
    await until('adapter drop', () => log.length > mark + 1)
    assert.deepEqual(await since(mark), [
      { type: 'drag_entered' },
      { type: 'drop', detail: ['a.txt'] },
    ])
    const drop = events.at(-1)
    assert(drop?.type === 'drop')
    assert.equal(drop.target, first)
    const resolved = await drop.items[0]!.resolve('work')
    assert.deepEqual(resolved, { root: 'work', path: 'a.txt' })
    const grant = await window.openFileGrant(resolved.root)
    assert.equal(new TextDecoder().decode((await grant.read(resolved.path)).bytes), 'alpha')
    await grant.close()
    outcomes['adapterDrop'] = { items: ['a.txt'], resolved, grantRead: 'alpha' }

    // Unmounting the zone through framework state mid-drag revokes the target.
    mark = log.length
    assert.deepEqual(await xdnd.send('enter 130 150'), { status: accepted, conversions: 1 })
    await until('drag entry before unmount', () => log.length > mark)
    const entered = events.at(-1)!
    mounted.show(false)
    await view.flush()
    assert.equal(mounted.mounted(), false)
    assert.equal(first.active, false)
    assert.equal(entered.signal.aborted, true)
    assert.deepEqual(await xdnd.send('move 131 151'), { status: accepted, conversions: 1 })
    assert.deepEqual(await xdnd.send('drop'), { finished: accepted })
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
    assert.deepEqual(await xdnd.send('enter 130 150'), { status: accepted, conversions: 1 })
    // GPUI evaluates drag hover against its last painted frame, and only on
    // pointer motion. Like any real drag, keep moving until a frame that
    // contains the freshly registered element has been painted.
    for (let step = 1; log.length === mark && step <= 40; step++) {
      await Bun.sleep(25)
      const position = `${130 + (step % 2)} ${150 + (step % 2)}`
      assert.deepEqual(await xdnd.send('move ' + position), { status: accepted, conversions: 1 })
    }
    await until('remounted entry', () => log.length > mark)
    assert.deepEqual(await xdnd.send('leave'), { left: true })
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
    assert.deepEqual(await xdnd.send('enter 130 150'), { status: accepted, conversions: 1 })
    assert.deepEqual(await xdnd.send('drop'), { finished: accepted })
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
      { status: 'passed', framework, mode, outcomes, ownership: app.diagnostics },
      null,
      2
    ) + '\n'
  )
  console.log(`${framework} drag and drop adapter passed`)
}
