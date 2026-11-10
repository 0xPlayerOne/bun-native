/** @jsxImportSource @bun-native/react */
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createApplication, type NativeApplication, type NativeNode } from '@bun-native/core'
import { render } from '@bun-native/react'
import { Workspace } from '../../examples/react-workspace/app.tsx'
import type { WorkspaceState } from '../../examples/react-workspace/model.ts'
import { observeWindow } from '../renderers/support.ts'
import { until } from './support.ts'

// The overlay peer advertises overlays, focus requests and accessibility
// labels, and routes deterministic events. It renders nothing and traps no
// focus: the native Tab trap, autofocus and focus return are covered by the
// real-host react-workspace scenario.
async function withOverlayPeer(run: (app: NativeApplication) => Promise<void>) {
  const app = await createApplication({
    executable: process.execPath,
    args: [
      resolve(import.meta.dir, '../core/overlay-peer.ts'),
      '--overlays',
      '--keyboard',
      '--split-resize',
    ],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics).toMatchObject({ windows: 0, nodes: 0, callbacks: 0 })
}

type Spec = {
  type: 'click' | 'key_down' | 'pointer_down'
  target: string
  shift?: boolean
}

test('workspace clears completed tasks only through its in-app modal confirmation', () =>
  withOverlayPeer(async (app) => {
    const actual = await app.openWindow({ title: 'Workspace clear confirmation' })
    const marker = await actual.batch((batch) => {
      const node = batch.create({ kind: 'text', text: 'Marker' })
      batch.append(actual.root, node)
      return node
    })
    const { window, observations } = observeWindow(actual)
    const focused: NativeNode[] = []
    actual.on(actual.root, 'focus', (event) => void focused.push(event.node), { capture: true })
    let state: WorkspaceState | undefined
    let changes = 0
    const root = render(
      <Workspace
        onChange={(next) => {
          state = next
          changes++
        }}
      />,
      window,
      { style: { width: 'fill', height: 'fill' } }
    )
    async function send(...specs: Spec[]) {
      const before = changes
      await actual.batch((batch) =>
        batch.set(marker, { kind: 'text', text: `event:${JSON.stringify(specs)}` })
      )
      await until(() => changes > before)
      await root.flush()
    }
    async function inert(spec: Spec) {
      const before = changes
      await actual.batch((batch) =>
        batch.set(marker, { kind: 'text', text: `event:${JSON.stringify([spec])}` })
      )
      await until(
        () => app.diagnostics.activeCallbacks === 0 && app.diagnostics.queuedCallbacks === 0
      )
      await root.flush()
      expect(changes).toBe(before)
    }
    try {
      await root.ready
      expect(state?.confirmingClear).toBe(false)

      // Escape on the panel keeps the one completed task.
      await send({ type: 'click', target: 'Clear completed (1)' })
      expect(state?.confirmingClear).toBe(true)
      await inert({ type: 'key_down', target: 'overlay#0', shift: true })
      expect(state?.confirmingClear).toBe(true)
      await send({ type: 'key_down', target: 'overlay#0' })
      expect(state?.confirmingClear).toBe(false)
      expect(state?.tasks).toHaveLength(12)

      // A press on the backdrop keeps them too, as does Keep tasks.
      await send({ type: 'click', target: 'Complete' })
      await send({ type: 'click', target: 'Clear completed (2)' })
      await send({ type: 'pointer_down', target: 'overlay#0' })
      expect(state?.confirmingClear).toBe(false)
      await send({ type: 'click', target: 'Clear completed (2)' })
      await send({ type: 'click', target: 'Keep tasks' })
      expect(state?.confirmingClear).toBe(false)
      expect(state?.tasks.filter((task) => task.completed)).toHaveLength(2)

      // Confirming removes both and moves focus to the composer, because the
      // control that opened the panel is now disabled.
      await send({ type: 'click', target: 'Clear completed (2)' })
      const focusRequests = focused.length
      await send({ type: 'click', target: 'Clear 2 tasks' })
      expect(state?.tasks.map((task) => task.id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
      expect(state?.selectedId).toBe(3)
      expect(state?.confirmingClear).toBe(false)
      await until(() => focused.length > focusRequests)
      expect(focused.at(-1)).toBe(observations.inputs[0]!)

      await actual.close()
      await root.closed
      expect(root.diagnostics.nodes).toBe(0)
      expect(root.diagnostics.listeners).toBe(0)
    } finally {
      await root.dispose()
    }
  }))
