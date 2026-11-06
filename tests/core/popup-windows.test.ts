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
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

async function withApp(run: (app: NativeApplication) => Promise<void>, popups = true) {
  const app = await createApplication({
    executable: process.execPath,
    args: [
      resolve(import.meta.dir, 'overlay-peer.ts'),
      '--overlays',
      ...(popups ? ['--popups'] : []),
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

const menu = {
  kind: 'overlay',
  anchor: 'parent',
  surface: 'window',
  style: { width: 160, height: 96 },
} as const

describe('popup window overlay contract (headless subprocess)', () => {
  test('a host without popup_windows_v1 rejects popup surfaces locally', () =>
    withApp(async (app) => {
      expect(app.capabilities).toContain('overlays_v1')
      expect(app.capabilities).not.toContain('popup_windows_v1')
      const window = await app.openWindow({ title: 'No popups' })
      await assert.rejects(
        window.batch((batch) => batch.create(menu)),
        (error: unknown) =>
          error instanceof UnsupportedFeatureError && error.feature === 'overlay:surface_window'
      )
      // The in-window layer stays available.
      await window.batch((batch) =>
        batch.append(window.root, batch.create({ kind: 'overlay', anchor: 'parent' }))
      )
      expect(window.revision).toBe(1)
    }, false))

  test('popup content rejects editors and nested layers before dispatch', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Popup content' })
      const popup = await window.batch((batch) => {
        const popup = batch.create(menu)
        batch.append(window.root, popup)
        batch.append(popup, batch.create({ kind: 'button', text: 'Copy' }))
        return popup
      })
      for (const element of [
        { kind: 'input', value: '' },
        { kind: 'overlay', anchor: 'parent' },
      ] as const)
        await assert.rejects(
          window.batch((batch) => {
            const group = batch.create({ kind: 'box' })
            batch.append(popup, group)
            batch.append(group, batch.create(element))
          }),
          (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_state'
        )
      for (const element of [
        { kind: 'overlay', surface: 'window', style: { width: 10, height: 10 } },
        { kind: 'overlay', anchor: 'parent', surface: 'window', style: { width: 10 } },
      ])
        await assert.rejects(
          window.batch((batch) => batch.create(element as never)),
          ProtocolError
        )
      expect(window.revision).toBe(1)
      expect(app.diagnostics.nodes).toBe(3)
    }))

  test('blur and Escape dismiss the popup; removal revokes every registration', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Popup dismissal' })
      const { probe, popup, dialog } = await window.batch((batch) => {
        const probe = batch.create({ kind: 'text', text: 'probe' })
        // A popup may open from inside a modal dialog layer.
        const dialog = batch.create({ kind: 'overlay', modal: true })
        const popup = batch.create(menu)
        batch.append(window.root, probe)
        batch.append(window.root, dialog)
        batch.append(dialog, popup)
        batch.append(popup, batch.create({ kind: 'button', text: 'Copy' }))
        return { probe, popup, dialog }
      })
      const dismissed: [string, DismissEvent['reason']][] = []
      const record = (name: string) => (event: DismissEvent) => {
        dismissed.push([name, event.reason])
      }
      onDismiss(window, popup, record('popup'))
      onDismiss(window, dialog, record('dialog'))
      expect(app.diagnostics.callbacks).toBe(6)
      await trigger(window, probe, [
        { type: 'dismiss', target: 'overlay#1' },
        { type: 'key_down', target: 'overlay#1', key: 'escape' },
        { type: 'pointer_down', target: 'overlay#1' },
      ])
      await waitFor(() => dismissed.length === 3, 'three dismissals')
      // Each request stops at the popup; the dialog beneath it sees none.
      expect(dismissed).toEqual([
        ['popup', 'blur'],
        ['popup', 'escape'],
        ['popup', 'backdrop'],
      ])
      await window.batch((batch) => batch.remove(popup))
      expect(app.diagnostics.callbacks).toBe(3)
      await window.close()
    }))

  test('a dismissal that removes its popup discards queued requests', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Popup disposal' })
      const { probe, popup } = await window.batch((batch) => {
        const probe = batch.create({ kind: 'text', text: 'probe' })
        const popup = batch.create(menu)
        batch.append(window.root, probe)
        batch.append(window.root, popup)
        return { probe, popup }
      })
      let calls = 0
      onDismiss(window, popup, async () => {
        calls += 1
        await window.batch((batch) => batch.remove(popup))
      })
      await trigger(window, probe, [
        { type: 'dismiss', target: 'overlay#0' },
        { type: 'dismiss', target: 'overlay#0' },
        { type: 'key_down', target: 'overlay#0', key: 'escape' },
      ])
      await waitFor(() => app.diagnostics.callbacks === 0, 'popup disposal')
      await waitFor(() => app.diagnostics.queuedCallbacks === 0, 'queue drain')
      expect(calls).toBe(1)
    }))

  test('a dismiss event aimed at a non-popup node is a protocol violation', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Misrouted dismissal' })
      const probe = await window.batch((batch) => {
        const probe = batch.create({ kind: 'text', text: 'probe' })
        batch.append(window.root, probe)
        batch.append(window.root, batch.create({ kind: 'overlay', anchor: 'parent' }))
        return probe
      })
      await trigger(window, probe, [{ type: 'dismiss', target: 'overlay#0' }])
      await assert.rejects(app.closed, ProtocolError)
    }))
})
