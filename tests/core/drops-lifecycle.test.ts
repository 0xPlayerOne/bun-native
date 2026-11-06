import { describe, expect, test } from 'bun:test'
import { MAX_DROP_ITEMS, MAX_DROP_TARGETS } from '@bun-native/protocol'
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

// Headless: the peer scripts host events and is never evidence of a real drag.
const ALLOWED: ServicePermissions = {
  dragDrop: 'allow',
  filesystemRoots: [{ id: 'work', path: '/srv/work', access: 'read' }],
}
const ZERO = [0, 0, 0, 0, 0, 0, 0]

function launch(directory: string, mode = 'normal') {
  return createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'drop-peer.ts'), directory, mode],
    permissions: ALLOWED,
    requestTimeoutMs: 2_000,
  })
}

async function withDrops(
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'normal'
) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-drops-lifecycle-'))
  let app: NativeApplication | undefined
  try {
    app = await launch(directory, mode)
    await run(app, directory)
  } finally {
    await app?.shutdown().catch(() => {})
    await app?.closed.catch(() => {})
    if (app) expect(Object.values(app.diagnostics)).toEqual(ZERO)
    rmSync(directory, { recursive: true, force: true })
  }
}

/** The channel must fail with a protocol error after `events` are emitted. */
async function failsChannel(
  prepare: (app: NativeApplication, scripted: Fixture) => Promise<object[]>
) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-drops-lifecycle-'))
  try {
    const app = await launch(directory)
    const scripted = await fixture(app)
    const events = await prepare(app, scripted)
    await scripted.script(events).catch(() => {})
    await assert.rejects(app.closed, ProtocolError)
    await app.shutdown().catch(() => {})
    expect(Object.values(app.diagnostics)).toEqual(ZERO)
  } finally {
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
  /** Each call makes the peer emit the given drop events after the commit. */
  script(events: object[]): Promise<void>
}

async function fixture(app: NativeApplication, title = 'Drops'): Promise<Fixture> {
  const window = await app.openWindow({ title })
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

const drag = (target_id: number, state: 'entered' | 'left') => ({
  type: 'drop_target_drag',
  target_id,
  state,
})
const received = (target_id: number, drop_id: number, names: string[]) => ({
  type: 'drop_received',
  target_id,
  drop_id,
  items: names.map((name) => ({ name })),
})
const rejected = (target_id: number, reason: string) => ({
  type: 'drop_rejected',
  target_id,
  reason,
})
const names = (count: number) => Array.from({ length: count }, (_, index) => `f${index}.txt`)

describe('drop target bounds and identities (headless subprocess)', () => {
  test('a drop at the 64-item limit keeps every index resolvable; rejections are typed', async () => {
    await withDrops(async (app, directory) => {
      const { window, zone, script } = await fixture(app)
      const events: DropTargetEvent[] = []
      await window.registerDropTarget(zone, (event) => void events.push(event))
      await script([received(1, 1, names(MAX_DROP_ITEMS))])
      await until(() => events.length === 1)
      const drop = events[0]!
      assert(drop.type === 'drop')
      expect(drop.items).toHaveLength(64)
      expect(drop.items[63]!.name).toBe('f63.txt')
      expect(await drop.items[63]!.resolve('work')).toEqual({ root: 'work', path: 'a.txt' })
      expect(requests(directory, 'resolve_dropped_item').map((item) => item['item'])).toEqual([63])

      await script([rejected(1, 'limit_exceeded'), rejected(1, 'empty')])
      await until(() => events.length === 3)
      expect(
        events.slice(1).map((event) => event.type === 'drop_rejected' && event.reason)
      ).toEqual(['limit_exceeded', 'empty'])
      // A rejection carries no items and retires the previous drop.
      expect(Object.keys(events[1]!).sort()).toEqual(
        ['reason', 'sequence', 'signal', 'target', 'type'].sort()
      )
      await assert.rejects(drop.items[0]!.resolve('work'), code('cancelled'))
      expect(requests(directory, 'resolve_dropped_item')).toHaveLength(1)
    })
  })

  test('a drop above the item limit is never truncated: it fails the channel', async () => {
    await failsChannel(async (_app, { window, zone }) => {
      await window.registerDropTarget(zone, () => {})
      return [received(1, 1, names(MAX_DROP_ITEMS + 1))]
    })
  })

  test('drag hover maps to entered and left with increasing sequences', async () => {
    await withDrops(async (app) => {
      const { window, zone, script } = await fixture(app)
      const events: DropTargetEvent[] = []
      const target = await window.registerDropTarget(zone, (event) => void events.push(event))
      await script([drag(1, 'entered'), drag(1, 'left'), drag(1, 'entered')])
      await until(() => events.length === 3)
      expect(events.map((event) => event.type)).toEqual([
        'drag_entered',
        'drag_left',
        'drag_entered',
      ])
      const sequences = events.map((event) => event.sequence)
      expect([...sequences].sort((a, b) => a - b)).toEqual(sequences)
      expect(new Set(sequences).size).toBe(3)
      for (const event of events) {
        expect(Object.isFrozen(event)).toBe(true)
        expect(event.target).toBe(target)
        expect(event.signal.aborted).toBe(false)
      }
      // Every event of one registration shares that registration's signal.
      expect(new Set(events.map((event) => event.signal)).size).toBe(1)
    })
  })

  test('target identities increase across close, re-registration and windows', async () => {
    await withDrops(async (app, directory) => {
      const first = await fixture(app, 'First')
      const second = await fixture(app, 'Second')
      const a = await first.window.registerDropTarget(first.zone, () => {})
      await a.close()
      const b = await first.window.registerDropTarget(first.zone, () => {})
      const c = await second.window.registerDropTarget(second.zone, () => {})
      expect(a).not.toBe(b)
      expect([a.active, b.active, c.active]).toEqual([false, true, true])
      expect(
        requests(directory, 'register_drop_target').map(({ window_id, target_id }) => ({
          window_id,
          target_id,
        }))
      ).toEqual([
        { window_id: 1, target_id: 1 },
        { window_id: 1, target_id: 2 },
        { window_id: 2, target_id: 3 },
      ])
    })
  })

  test('drop identities may skip but must increase across the whole session', async () => {
    await withDrops(async (app) => {
      const { window, zone, script } = await fixture(app)
      const events: DropTargetEvent[] = []
      await window.registerDropTarget(zone, (event) => void events.push(event))
      await script([received(1, 3, ['a']), received(1, 9, ['b'])])
      await until(() => events.length === 2)
    })
    await failsChannel(async (_app, { window, zone }) => {
      await window.registerDropTarget(zone, () => {})
      return [received(1, 5, ['a']), received(1, 4, ['b'])]
    })
    await failsChannel(async (_app, { window, zone }) => {
      await window.registerDropTarget(zone, () => {})
      await window.registerDropTarget(window.root, () => {})
      return [received(1, 1, ['a']), received(2, 1, ['b'])]
    })
    // A drop for a revoked target is discarded but still consumes its identity.
    await failsChannel(async (_app, { window, zone }) => {
      const gone = await window.registerDropTarget(zone, () => {})
      await gone.close()
      await window.registerDropTarget(window.root, () => {})
      return [received(1, 2, ['late']), received(2, 2, ['b'])]
    })
  })

  test('one target per node and at most 32 live targets per session', async () => {
    await withDrops(async (app) => {
      const window = await app.openWindow({ title: 'Bounds' })
      const nodes = await window.batch((batch) =>
        Array.from({ length: MAX_DROP_TARGETS + 1 }, () => {
          const node = batch.create({ kind: 'box' })
          batch.append(window.root, node)
          return node
        })
      )
      const first = await window.registerDropTarget(nodes[0]!, () => {})
      await assert.rejects(
        window.registerDropTarget(nodes[0]!, () => {}),
        code('conflict')
      )
      expect(first.active).toBe(true)
      const targets = [first]
      for (const node of nodes.slice(1, MAX_DROP_TARGETS))
        targets.push(await window.registerDropTarget(node, () => {}))
      expect(targets).toHaveLength(MAX_DROP_TARGETS)
      await assert.rejects(
        window.registerDropTarget(nodes[MAX_DROP_TARGETS]!, () => {}),
        code('limit_exceeded')
      )
      // Closing one frees its slot for another node.
      await targets[5]!.close()
      const replacement = await window.registerDropTarget(nodes[MAX_DROP_TARGETS]!, () => {})
      expect(replacement.active).toBe(true)
    })
  })
})

describe('dropped item resolution (headless subprocess)', () => {
  test('root IDs are validated locally; host failures map to typed service errors', async () => {
    await withDrops(async (app, directory) => {
      const { window, zone, script } = await fixture(app)
      const events: DropTargetEvent[] = []
      await window.registerDropTarget(zone, (event) => void events.push(event))
      await script([received(1, 1, ['a.txt'])])
      await until(() => events.length === 1)
      const drop = events[0]!
      assert(drop.type === 'drop')
      const item = drop.items[0]!
      // Root IDs name launch roots; no path of any platform's style is one.
      for (const root of [
        '',
        'Work',
        '1work',
        'work/sub',
        '../work',
        '/srv/work',
        'C:\\work',
        'C:/work',
        '\\\\server\\share',
        'a'.repeat(33),
        42,
        undefined,
      ])
        await assert.rejects(item.resolve(root as string), TypeError)
      expect(requests(directory, 'resolve_dropped_item')).toEqual([])

      await assert.rejects(item.resolve('missing'), code('not_found'))
      // The host no longer holds this drop: no result is delivered.
      await assert.rejects(item.resolve('gone'), code('cancelled'))
      await assert.rejects(item.resolve('docs'), code('path_denied'))
      const resolved = await item.resolve('work')
      expect(resolved).toEqual({ root: 'work', path: 'a.txt' })
      expect(Object.isFrozen(resolved)).toBe(true)
      expect(requests(directory, 'resolve_dropped_item').map((entry) => entry['root'])).toEqual([
        'missing',
        'gone',
        'docs',
        'work',
      ])
    })
  })
})

describe('drop target revocation (headless subprocess)', () => {
  test('removing an ancestor revokes a descendant target', async () => {
    await withDrops(async (app, directory) => {
      const window = await app.openWindow({ title: 'Ancestor' })
      const { outer, inner } = await window.batch((batch) => {
        const outer = batch.create({ kind: 'box' })
        const inner = batch.create({ kind: 'box' })
        batch.append(window.root, outer)
        batch.append(outer, inner)
        return { outer, inner }
      })
      const signals: AbortSignal[] = []
      const target = await window.registerDropTarget(inner, () => {})
      const kept = await window.registerDropTarget(window.root, (event) => {
        signals.push(event.signal)
      })
      await window.batch((batch) => batch.remove(outer))
      expect(target.active).toBe(false)
      expect(kept.active).toBe(true)
      expect(requests(directory, 'unregister_drop_target')).toEqual([])
      await target.close()
      expect(requests(directory, 'unregister_drop_target')).toEqual([])
    })
  })

  test('registering a node whose removal is in flight fails as an invalid handle', async () => {
    await withDrops(async (app) => {
      const { window, zone } = await fixture(app)
      const removing = window.batch((batch) => batch.remove(zone))
      await assert.rejects(
        window.registerDropTarget(zone, () => {}),
        (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
      )
      await removing
    })
  })

  test('closing a target while its node removal is in flight settles quietly', async () => {
    await withDrops(async (app) => {
      const { window, zone } = await fixture(app)
      const target = await window.registerDropTarget(zone, () => {})
      const removing = window.batch((batch) => batch.remove(zone))
      const closing = target.close()
      expect(target.active).toBe(false)
      await Promise.all([removing, closing])
      expect(target.active).toBe(false)
    })
  })

  test('a node removal committed while registration is in flight cancels it', async () => {
    await withDrops(async (app, directory) => {
      const { window, zone } = await fixture(app)
      const registering = window.registerDropTarget(zone, () => {
        throw new Error('A cancelled registration must not deliver')
      })
      const outcome = registering.then(
        () => undefined,
        (error: unknown) => error
      )
      // The peer withholds the registration reply until this batch is applied.
      await until(() => requests(directory, 'register_drop_target').length === 1)
      await window.batch((batch) => batch.remove(zone))
      expect(code('cancelled')(await outcome)).toBe(true)
      expect(requests(directory, 'unregister_drop_target')).toEqual([])
    }, 'hold-register')
  })

  test('closing a target the host already dropped settles quietly', async () => {
    await withDrops(async (app, directory) => {
      const { window, zone, script } = await fixture(app)
      const target = await window.registerDropTarget(zone, () => {})
      await script([{ peer: 'forget', target_id: 1 }])
      await target.close()
      expect(target.active).toBe(false)
      expect(requests(directory, 'unregister_drop_target')).toHaveLength(1)
    })
  })

  test('window close revokes only that window; its late events are discarded', async () => {
    await withDrops(async (app, directory) => {
      const first = await fixture(app, 'First')
      const second = await fixture(app, 'Second')
      const events: DropTargetEvent[] = []
      const kept = await first.window.registerDropTarget(first.zone, (event) => {
        events.push(event)
      })
      const closedEvents: DropTargetEvent[] = []
      const gone = await second.window.registerDropTarget(second.zone, (event) => {
        closedEvents.push(event)
      })
      await second.script([received(2, 1, ['a.txt'])])
      await until(() => closedEvents.length === 1)
      const drop = closedEvents[0]!
      assert(drop.type === 'drop')
      await second.window.close()
      expect(gone.active).toBe(false)
      expect(drop.signal.aborted).toBe(true)
      expect(kept.active).toBe(true)
      await assert.rejects(drop.items[0]!.resolve('work'), code('cancelled'))
      expect(requests(directory, 'resolve_dropped_item')).toEqual([])
      expect(requests(directory, 'unregister_drop_target')).toEqual([])

      // Host events the closed window already queued, then one for a live target.
      await first.script([
        { ...drag(2, 'entered'), window_id: 2 },
        { ...received(2, 2, ['late']), window_id: 2 },
        drag(1, 'entered'),
      ])
      await until(() => events.length === 1)
      expect(events[0]!.type).toBe('drag_entered')
      expect(closedEvents).toHaveLength(1)
    })
  })

  test('shutdown aborts signals and withholds resolution without a native request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bun-native-drops-lifecycle-'))
    try {
      const app = await launch(directory)
      const { window, zone, script } = await fixture(app)
      const events: DropTargetEvent[] = []
      const target = await window.registerDropTarget(zone, (event) => void events.push(event))
      await script([received(1, 1, ['a.txt'])])
      await until(() => events.length === 1)
      const drop = events[0]!
      assert(drop.type === 'drop')
      await app.shutdown()
      await app.closed
      expect(target.active).toBe(false)
      expect(drop.signal.aborted).toBe(true)
      await assert.rejects(drop.items[0]!.resolve('work'), code('cancelled'))
      expect(requests(directory, 'resolve_dropped_item')).toEqual([])
      expect(requests(directory, 'unregister_drop_target')).toEqual([])
      expect(Object.values(app.diagnostics)).toEqual(ZERO)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a listener that never settles is released when its target closes', async () => {
    await withDrops(async (app) => {
      const { window, zone, script } = await fixture(app)
      let calls = 0
      const target = await window.registerDropTarget(zone, () => {
        calls += 1
        return new Promise<void>(() => {})
      })
      await script([drag(1, 'entered')])
      await until(() => calls === 1)
      expect(app.diagnostics.activeCallbacks).toBe(1)
      await target.close()
      await until(() => app.diagnostics.activeCallbacks === 0)
    })
  })
})
