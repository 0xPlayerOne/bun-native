import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  ProtocolError,
  type DropTargetEvent,
  type NativeApplication,
  type NativeNode,
  type NativeWindow,
  type ServicePermissions,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ALLOWED: ServicePermissions = {
  dragDrop: 'allow',
  filesystemRoots: [
    { id: 'work', path: '/srv/work', access: 'read' },
    { id: 'docs', path: '/srv/docs', access: 'read' },
  ],
}

function launch(directory: string, mode: string, permissions: ServicePermissions) {
  return createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'drop-peer.ts'), directory, mode],
    permissions,
    requestTimeoutMs: 2_000,
  })
}

async function withDrops(
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'normal',
  permissions: ServicePermissions = ALLOWED
) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-drop-peer-'))
  let app: NativeApplication | undefined
  try {
    app = await launch(directory, mode, permissions)
    await run(app, directory)
  } finally {
    await app?.shutdown().catch(() => {})
    await app?.closed.catch(() => {})
    if (app) expect(Object.values(app.diagnostics)).toEqual([0, 0, 0, 0, 0, 0, 0])
    rmSync(directory, { recursive: true, force: true })
  }
}

function requests(directory: string, type: string) {
  const path = join(directory, 'requests.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((value) => value['type'] === type)
}

const code = (expected: string) => (error: unknown) =>
  error instanceof NativeServiceError && error.service === 'drag_drop' && error.code === expected

interface Fixture {
  window: NativeWindow
  zone: NativeNode<'box'>
  /** Each `set` makes the peer emit the given drop events after the commit. */
  script(events: object[]): Promise<void>
}

async function fixture(app: NativeApplication): Promise<Fixture> {
  const window = await app.openWindow({ title: 'Drops' })
  const { zone, control } = await window.batch((batch) => {
    const zone = batch.create({ kind: 'box' })
    const control = batch.create({ kind: 'text', text: '' })
    batch.append(window.root, zone)
    batch.append(window.root, control)
    return { zone, control }
  })
  return {
    window,
    zone,
    script: (events) =>
      window.batch((batch) =>
        batch.set(control, { kind: 'text', text: 'drop:' + JSON.stringify(events) })
      ),
  }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for drop delivery')
    await Bun.sleep(2)
  }
}

const entered = (target_id: number) => ({ type: 'drop_target_drag', target_id, state: 'entered' })
const received = (target_id: number, drop_id: number, names: string[]) => ({
  type: 'drop_received',
  target_id,
  drop_id,
  items: names.map((name) => ({ name })),
})

describe('drag and drop through the public core (headless subprocess)', () => {
  test('capability records distinguish denial and unavailability', async () => {
    await withDrops(
      async (app) => {
        expect(app.serviceCapabilities.dragDrop).toEqual({
          availability: 'available',
          permission: 'deny',
          scope: 'owned_target',
          payload: 'files',
          backend:
            process.platform === 'darwin' ? 'appkit' : process.platform === 'win32' ? 'ole' : 'x11',
        })
        expect(Object.isFrozen(app.serviceCapabilities.dragDrop)).toBe(true)
        const { window, zone } = await fixture(app)
        await assert.rejects(
          window.registerDropTarget(zone, () => {}),
          code('permission_denied')
        )
      },
      'normal',
      {}
    )
    await withDrops(async (app) => {
      expect(app.serviceCapabilities.dragDrop).toEqual({
        availability: 'unavailable',
        reason: 'unsupported_platform',
      })
      const { window, zone } = await fixture(app)
      await assert.rejects(
        window.registerDropTarget(zone, () => {}),
        code('service_unavailable')
      )
    }, 'unavailable')
  })

  test('drops carry display names only; paths come from explicit root resolution', async () => {
    await withDrops(async (app, directory) => {
      const { window, zone, script } = await fixture(app)
      const events: DropTargetEvent[] = []
      const target = await window.registerDropTarget(zone, (event) => void events.push(event))
      expect(target.active).toBe(true)
      expect(target.node).toBe(zone)
      expect(Object.isFrozen(target)).toBe(true)
      await assert.rejects(window.registerDropTarget(zone, 'no' as never), TypeError)
      const [registration] = requests(directory, 'register_drop_target')
      expect(registration).toEqual({
        type: 'register_drop_target',
        id: expect.any(Number),
        window_id: 1,
        target_id: 1,
        node_id: 2,
      })

      await script([entered(1), received(1, 1, ['a.txt', 'b.txt'])])
      await until(() => events.length === 2)
      expect(events.map((event) => event.type)).toEqual(['drag_entered', 'drop'])
      const drop = events[1]!
      assert(drop.type === 'drop')
      expect(drop.target).toBe(target)
      expect(Object.isFrozen(drop)).toBe(true)
      expect(Object.isFrozen(drop.items)).toBe(true)
      expect(drop.items.map((item) => item.name)).toEqual(['a.txt', 'b.txt'])
      expect(Object.keys(drop.items[0]!)).toEqual(['name', 'resolve'])

      expect(await drop.items[1]!.resolve('work')).toEqual({ root: 'work', path: 'a.txt' })
      await assert.rejects(drop.items[0]!.resolve('docs'), code('path_denied'))
      await assert.rejects(drop.items[0]!.resolve('../work'), TypeError)
      await assert.rejects(drop.items[0]!.resolve('/srv/work'), TypeError)
      const resolutions = requests(directory, 'resolve_dropped_item')
      expect(resolutions.map(({ item, root, drop_id }) => ({ item, root, drop_id }))).toEqual([
        { item: 1, root: 'work', drop_id: 1 },
        { item: 0, root: 'docs', drop_id: 1 },
      ])

      // A newer drop or a rejection on the target retires older items locally.
      await script([received(1, 2, ['c.txt'])])
      await until(() => events.length === 3)
      await assert.rejects(drop.items[0]!.resolve('work'), code('cancelled'))
      await script([{ type: 'drop_rejected', target_id: 1, reason: 'limit_exceeded' }])
      await until(() => events.length === 4)
      const rejected = events[3]!
      assert(rejected.type === 'drop_rejected')
      expect(rejected.reason).toBe('limit_exceeded')
      const newer = events[2]!
      assert(newer.type === 'drop')
      await assert.rejects(newer.items[0]!.resolve('work'), code('cancelled'))
      expect(requests(directory, 'resolve_dropped_item')).toHaveLength(2)
    })
  })

  test('closing a target revokes it at once and drops late host events', async () => {
    await withDrops(async (app, directory) => {
      const { window, zone, script } = await fixture(app)
      const events: DropTargetEvent[] = []
      const target = await window.registerDropTarget(zone, (event) => void events.push(event))
      await script([entered(1), received(1, 1, ['a.txt'])])
      await until(() => events.length === 2)
      const [first, drop] = events
      assert(drop?.type === 'drop')
      const closing = target.close()
      expect(target.active).toBe(false)
      expect(first!.signal.aborted).toBe(true)
      await assert.rejects(drop.items[0]!.resolve('work'), code('cancelled'))
      await closing
      await target.close()
      expect(requests(directory, 'unregister_drop_target')).toHaveLength(1)
      await script([entered(1), received(1, 2, ['late.txt'])])
      await Bun.sleep(50)
      expect(events).toHaveLength(2)
      // The node can host a fresh target with a new identity.
      const again = await window.registerDropTarget(zone, (event) => void events.push(event))
      expect(again).not.toBe(target)
      await script([entered(2)])
      await until(() => events.length === 3)
      expect(events[2]!.target).toBe(again)
    })
  })

  test('a resolution in flight is withheld once the target is revoked', async () => {
    await withDrops(async (app) => {
      const { window, zone, script } = await fixture(app)
      const events: DropTargetEvent[] = []
      const target = await window.registerDropTarget(zone, (event) => void events.push(event))
      await script([received(1, 1, ['a.txt'])])
      await until(() => events.length === 1)
      const drop = events[0]!
      assert(drop.type === 'drop')
      const pending = drop.items[0]!.resolve('work')
      await target.close()
      await assert.rejects(pending, code('cancelled'))
    }, 'slow')
  })

  test('removing the node or closing the window revokes its targets', async () => {
    await withDrops(async (app, directory) => {
      const { window, zone, script } = await fixture(app)
      const events: DropTargetEvent[] = []
      const target = await window.registerDropTarget(zone, (event) => void events.push(event))
      const root = await window.registerDropTarget(window.root, (event) => void events.push(event))
      await window.batch((batch) => batch.remove(zone))
      expect(target.active).toBe(false)
      expect(root.active).toBe(true)
      await assert.rejects(
        window.registerDropTarget(zone, () => {}),
        NativeStateError
      )
      await script([entered(1), entered(2)])
      await until(() => events.length === 1)
      await Bun.sleep(50)
      expect(events.map((event) => event.target)).toEqual([root])
      // The host removes it with the node; no unregister is needed or sent.
      expect(requests(directory, 'unregister_drop_target')).toHaveLength(0)
      await window.close()
      expect(root.active).toBe(false)
      expect(events[0]!.signal.aborted).toBe(true)
      await root.close()
      expect(requests(directory, 'unregister_drop_target')).toHaveLength(0)
    })
  })

  test('shutdown revokes live targets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bun-native-drop-peer-'))
    try {
      const app = await launch(directory, 'normal', ALLOWED)
      const { window, zone } = await fixture(app)
      const target = await window.registerDropTarget(zone, () => {})
      await app.shutdown()
      await app.closed
      expect(target.active).toBe(false)
      await target.close()
      expect(Object.values(app.diagnostics)).toEqual([0, 0, 0, 0, 0, 0, 0])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  for (const [name, events] of [
    ['an unallocated target', [entered(9)]],
    ['a repeated drop identity', [received(1, 1, ['a']), received(1, 1, ['b'])]],
    ['a target outside its owner window', [{ ...entered(1), window_id: 2 }]],
  ] as const)
    test(`events naming ${name} are protocol errors`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'bun-native-drop-peer-'))
      try {
        const app = await launch(directory, 'normal', ALLOWED)
        const { window, zone, script } = await fixture(app)
        await app.openWindow({ title: 'Other' })
        await window.registerDropTarget(zone, () => {})
        await script(events as unknown as object[]).catch(() => {})
        await assert.rejects(app.closed, ProtocolError)
        await app.shutdown().catch(() => {})
        expect(Object.values(app.diagnostics)).toEqual([0, 0, 0, 0, 0, 0, 0])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

  test('a resolved path that is not relative is a protocol error', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bun-native-drop-peer-'))
    try {
      const app = await launch(directory, 'absolute', ALLOWED)
      const { window, zone, script } = await fixture(app)
      const events: DropTargetEvent[] = []
      await window.registerDropTarget(zone, (event) => void events.push(event))
      await script([received(1, 1, ['a.txt'])])
      await until(() => events.length === 1)
      const drop = events[0]!
      assert(drop.type === 'drop')
      await drop.items[0]!.resolve('work').catch(() => {})
      await assert.rejects(app.closed, ProtocolError)
      await app.shutdown().catch(() => {})
      expect(Object.values(app.diagnostics)).toEqual([0, 0, 0, 0, 0, 0, 0])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
