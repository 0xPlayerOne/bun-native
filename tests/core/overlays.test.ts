import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeStateError,
  onDismiss,
  ProtocolError,
  UnsupportedFeatureError,
  type DismissEvent,
  type NativeApplication,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'
import { MAX_OVERLAY_DEPTH } from '@bun-native/protocol'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

async function withApp(run: (app: NativeApplication) => Promise<void>, overlays = true) {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'overlay-peer.ts'), ...(overlays ? ['--overlays'] : [])],
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

/** Ask the peer to emit routed events after this batch's acknowledgement. */
function trigger(window: NativeWindow, trigger: NativeNode<'text'>, events: unknown[]) {
  return window.batch((batch) =>
    batch.set(trigger, { kind: 'text', text: 'event:' + JSON.stringify(events) })
  )
}

describe('overlay contract (headless subprocess)', () => {
  test('a host without the optional capabilities rejects overlays and scroll anchors locally', () =>
    withApp(async (app) => {
      expect(app.capabilities).not.toContain('overlays_v1')
      const window = await app.openWindow({ title: 'No overlays' })
      await assert.rejects(
        window.batch((batch) => batch.create({ kind: 'overlay', modal: true })),
        (error: unknown) =>
          error instanceof UnsupportedFeatureError && error.feature === 'element:overlay'
      )
      await assert.rejects(
        window.batch((batch) =>
          batch.create({ kind: 'box', style: { overflow: 'scroll_y', scroll_anchor: 'end' } })
        ),
        (error: unknown) =>
          error instanceof UnsupportedFeatureError && error.feature === 'style:scroll_anchor'
      )
      expect(window.revision).toBe(0)
    }, false))

  test('overlays own children, reject modal parent anchoring and bound nesting before dispatch', () =>
    withApp(async (app) => {
      expect(app.capabilities).toContain('overlays_v1')
      expect(app.capabilities).toContain('scroll_anchor_v1')
      const window = await app.openWindow({ title: 'Overlay ownership' })
      const deepest = await window.batch((batch) => {
        let parent: NativeNode<'box' | 'overlay'> = window.root
        for (let depth = 0; depth < MAX_OVERLAY_DEPTH; depth++) {
          const overlay = batch.create({ kind: 'overlay', modal: depth === 0 })
          batch.append(parent, overlay)
          parent = overlay
        }
        const log = batch.create({
          kind: 'box',
          style: { overflow: 'scroll_y', scroll_anchor: 'end' },
        })
        batch.append(parent, log)
        return parent
      })
      expect(window.revision).toBe(1)
      await assert.rejects(
        window.batch((batch) => batch.append(deepest, batch.create({ kind: 'overlay' }))),
        (error: unknown) => error instanceof NativeStateError && error.code === 'limit_exceeded'
      )
      await assert.rejects(
        window.batch((batch) =>
          batch.create({ kind: 'overlay', anchor: 'parent', modal: true } as never)
        ),
        ProtocolError
      )
      await assert.rejects(
        window.batch((batch) => {
          const text = batch.create({ kind: 'text', text: 'leaf' })
          batch.append(text as never, batch.create({ kind: 'overlay' }))
        }),
        (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_state'
      )
      expect(window.revision).toBe(1)
      expect(app.diagnostics.nodes).toBe(MAX_OVERLAY_DEPTH + 2)
    }))

  test('Escape dismisses only the innermost overlay and a backdrop press only its own layer', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Dismissal' })
      const { probe, outer, inner } = await window.batch((batch) => {
        const probe = batch.create({ kind: 'text', text: 'probe' })
        const outer = batch.create({ kind: 'overlay', modal: true })
        const inner = batch.create({ kind: 'overlay', modal: true })
        const save = batch.create({ kind: 'button', text: 'Save' })
        batch.append(window.root, probe)
        batch.append(window.root, outer)
        batch.append(outer, inner)
        batch.append(inner, save)
        return { probe, outer, inner }
      })
      const dismissed: [string, DismissEvent['reason'], number][] = []
      const record = (name: string) => (event: DismissEvent) => {
        dismissed.push([name, event.reason, event.event.sequence])
      }
      const stopOuter = onDismiss(window, outer, record('outer'))
      onDismiss(window, inner, record('inner'))
      expect(app.diagnostics.callbacks).toBe(6)

      await trigger(window, probe, [
        { type: 'key_down', target: 'Save', key: 'escape' },
        { type: 'key_down', target: 'Save', key: 'escape', shift: true },
        { type: 'key_down', target: 'Save', key: 'a' },
        { type: 'pointer_down', target: 'Save' },
        { type: 'pointer_down', target: 'overlay#1' },
        { type: 'pointer_down', target: 'overlay#0' },
        { type: 'key_down', target: 'overlay#0', key: 'escape' },
      ])
      await waitFor(() => dismissed.length === 4, 'four dismissals')
      expect(dismissed.map(([name, reason]) => [name, reason])).toEqual([
        ['inner', 'escape'],
        ['inner', 'backdrop'],
        ['outer', 'backdrop'],
        ['outer', 'escape'],
      ])

      // Unsubscribing revokes all three registrations; removal revokes the rest.
      stopOuter()
      expect(app.diagnostics.callbacks).toBe(3)
      await window.batch((batch) => batch.remove(outer))
      expect(app.diagnostics.callbacks).toBe(0)
      expect(app.diagnostics.nodes).toBe(2)
      await window.close()
    }))

  test('a dismissal that removes its overlay revokes queued callbacks for that layer', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Disposal' })
      const { probe, overlay } = await window.batch((batch) => {
        const probe = batch.create({ kind: 'text', text: 'probe' })
        const overlay = batch.create({ kind: 'overlay', modal: true })
        batch.append(window.root, probe)
        batch.append(window.root, overlay)
        batch.append(overlay, batch.create({ kind: 'button', text: 'Close' }))
        return { probe, overlay }
      })
      let calls = 0
      let revoked: AbortSignal | undefined
      onDismiss(window, overlay, async ({ event }) => {
        calls += 1
        revoked = event.signal
        await window.batch((batch) => batch.remove(overlay))
      })
      await trigger(window, probe, [
        { type: 'key_down', target: 'Close', key: 'escape' },
        { type: 'key_down', target: 'Close', key: 'escape' },
        { type: 'pointer_down', target: 'overlay#0' },
      ])
      await waitFor(() => app.diagnostics.callbacks === 0, 'overlay disposal')
      await waitFor(() => app.diagnostics.queuedCallbacks === 0, 'queue drain')
      expect(calls).toBe(1)
      expect(revoked?.aborted).toBe(true)
      expect(app.diagnostics.nodes).toBe(2)
    }))
})
