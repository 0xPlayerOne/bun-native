import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeStateError,
  onSplitResize,
  ProtocolError,
  UnsupportedFeatureError,
  type NativeApplication,
  type NativeNode,
  type NativeWindow,
  type SplitResizeEvent,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

async function withApp(run: (app: NativeApplication) => Promise<void>, resize = true) {
  const app = await createApplication({
    executable: process.execPath,
    args: [
      resolve(import.meta.dir, 'overlay-peer.ts'),
      '--overlays',
      '--splits',
      ...(resize ? ['--split-resize'] : []),
    ],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics).toMatchObject({ windows: 0, nodes: 0, callbacks: 0, activeCallbacks: 0 })
}

async function waitFor(check: () => boolean, description: string) {
  const until = performance.now() + 2_000
  while (!check()) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(1)
  }
}

function trigger(window: NativeWindow, probe: NativeNode<'text'>, events: unknown[]) {
  return window.batch((batch) =>
    batch.set(probe, { kind: 'text', text: 'event:' + JSON.stringify(events) })
  )
}

async function scene(window: NativeWindow) {
  return window.batch((batch) => {
    const probe = batch.create({ kind: 'text', text: '' })
    const outer = batch.create({ kind: 'split', ratio: 0.5, accessible_label: 'Sidebar' })
    const inner = batch.create({ kind: 'split', ratio: 0.5, style: { direction: 'column' } })
    batch.append(window.root, probe)
    batch.append(window.root, outer)
    batch.append(outer, batch.create({ kind: 'button', text: 'Leading' }))
    batch.append(outer, inner)
    return { probe, outer, inner }
  })
}

describe('split resize contract (headless subprocess)', () => {
  test('a host without split_resize_v1 rejects the listener and labels locally', () =>
    withApp(async (app) => {
      expect(app.capabilities).toContain('split_v1')
      expect(app.capabilities).not.toContain('split_resize_v1')
      expect(app.capabilities).not.toContain('accessibility_v1')
      const window = await app.openWindow({ title: 'No split resize' })
      const split = await window.batch((batch) => {
        const split = batch.create({ kind: 'split' })
        batch.append(window.root, split)
        return split
      })
      assert.throws(
        () => onSplitResize(window, split, () => {}),
        (error: unknown) =>
          error instanceof UnsupportedFeatureError && error.feature === 'event:split_resize'
      )
      assert.throws(
        () => window.on(split, 'split_resize', () => {}),
        (error: unknown) => error instanceof UnsupportedFeatureError
      )
      for (const element of [
        { kind: 'split', accessible_label: 'Sidebar' },
        { kind: 'overlay', modal: true, accessible_label: 'Rename' },
      ] as const)
        await assert.rejects(
          window.batch((batch) => batch.append(window.root, batch.create(element))),
          (error: unknown) =>
            error instanceof UnsupportedFeatureError &&
            error.feature === element.kind + ':accessible_label'
        )
      expect(window.revision).toBe(1)
    }, false))

  test('pointer and keyboard resizes reach the split listener with their source', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Split resize' })
      const { probe, outer, inner } = await scene(window)
      const seen: SplitResizeEvent[] = []
      const bubbled: string[] = []
      const remove = onSplitResize(window, outer, (event) => {
        seen.push(event)
      })
      // A nested split's resize also reaches the outer split's capture
      // listener, but the helper reports only its own split.
      window.on(
        outer,
        'split_resize',
        (event) => {
          bubbled.push(event.node === inner ? 'inner' : 'outer')
        },
        { capture: true }
      )
      await trigger(window, probe, [
        { type: 'split_resize', target: 'split#0', ratio: 0.25, source: 'pointer' },
        { type: 'split_resize', target: 'split#1', ratio: 0.6, source: 'keyboard' },
        { type: 'split_resize', target: 'split#0', ratio: 0.26, source: 'keyboard' },
      ])
      await waitFor(() => bubbled.length === 3, 'split resize events')
      expect(bubbled).toEqual(['outer', 'inner', 'outer'])
      expect(seen.map(({ ratio, source }) => [ratio, source])).toEqual([
        [0.25, 'pointer'],
        [0.26, 'keyboard'],
      ])
      expect(seen[0]!.node).toBe(outer)
      expect(seen[0]!.type).toBe('split_resize')
      remove()
      remove()
      await trigger(window, probe, [
        { type: 'split_resize', target: 'split#0', ratio: 0.3, source: 'pointer' },
      ])
      await waitFor(() => bubbled.length === 4, 'resize after removal')
      expect(seen).toHaveLength(2)
      await window.close()
    }))

  test('removing the split revokes its listener; non-split handles are refused', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Split lifetime' })
      const { outer, probe } = await scene(window)
      const listener = () => {}
      onSplitResize(window, outer, listener)
      expect(app.diagnostics).toMatchObject({ callbacks: 1 })
      assert.throws(
        () => onSplitResize(window, probe as unknown as NativeNode<'split'>, listener),
        (error: unknown) => error instanceof NativeStateError
      )
      await window.batch((batch) => batch.remove(outer))
      expect(app.diagnostics).toMatchObject({ callbacks: 0 })
      assert.throws(() => onSplitResize(window, outer, listener), NativeStateError)
      await window.close()
    }))

  test('a resize that targets a non-split node is a protocol error', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Wrong target' })
      const probe = await window.batch((batch) => {
        const probe = batch.create({ kind: 'text', text: '' })
        batch.append(window.root, probe)
        batch.append(window.root, batch.create({ kind: 'button', text: 'Target' }))
        return probe
      })
      const failed = app.closed.then(
        () => undefined,
        (error: unknown) => error
      )
      await trigger(window, probe, [
        { type: 'split_resize', target: 'Target', ratio: 0.5, source: 'pointer' },
      ]).catch(() => {})
      expect(await failed).toBeInstanceOf(ProtocolError)
    }))
})
