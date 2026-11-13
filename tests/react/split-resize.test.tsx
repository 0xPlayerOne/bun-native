/** @jsxImportSource @bun-native/react */
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  createApplication,
  type DismissRequestEvent,
  type SplitResizeEvent,
} from '@bun-native/core'
import { render } from '@bun-native/react'
import { createElement, setProperty, snapshot } from '../../packages/renderer/src/nodes.ts'

test('accessibleLabel validates and reaches splits and overlays', () => {
  const split = createElement('split')
  setProperty(split, 'accessibleLabel', 'Sidebar')
  expect(snapshot(split).get(split)?.element).toEqual({
    kind: 'split',
    accessible_label: 'Sidebar',
  })
  setProperty(split, 'accessibleLabel', undefined)
  expect(snapshot(split).get(split)?.element).toEqual({ kind: 'split' })
  const overlay = createElement('overlay')
  setProperty(overlay, 'accessibleLabel', 'Rename')
  expect(snapshot(overlay).get(overlay)?.element).toEqual({
    kind: 'overlay',
    accessible_label: 'Rename',
  })
  for (const [node, value] of [
    [split, 3],
    [createElement('text'), 'Name'],
    [createElement('button'), 'Name'],
  ] as const)
    expect(() => setProperty(node, 'accessibleLabel', value)).toThrow(TypeError)
})

test('React onSplitResize receives the host-owned ratio and its source', async () => {
  const app = await createApplication({
    executable: process.execPath,
    args: [
      resolve(import.meta.dir, '../core/overlay-peer.ts'),
      '--overlays',
      '--splits',
      '--split-resize',
    ],
    requestTimeoutMs: 1_000,
  })
  try {
    const window = await app.openWindow({ title: 'React split resize' })
    const seen: Array<[number, string]> = []
    const view = (probe: string) => (
      <box>
        <text>{probe}</text>
        <split
          ratio={0.5}
          accessibleLabel="Sidebar"
          onSplitResize={(event: SplitResizeEvent) => void seen.push([event.ratio, event.source])}
        >
          <box />
          <box />
        </split>
      </box>
    )
    const root = render(view(''), window)
    await root.ready
    const events = [
      { type: 'split_resize', target: 'split#0', ratio: 0.3, source: 'pointer' },
      { type: 'split_resize', target: 'split#0', ratio: 0.31, source: 'keyboard' },
    ]
    root.render(view('event:' + JSON.stringify(events)))
    const until = performance.now() + 2_000
    while (seen.length < 2 && performance.now() < until) await Bun.sleep(1)
    expect(seen).toEqual([
      [0.3, 'pointer'],
      [0.31, 'keyboard'],
    ])
    await root.dispose()
    await window.close()
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics).toMatchObject({ windows: 0, nodes: 0, callbacks: 0 })
})

test('React onDismiss observes a popup window losing its parent focus', async () => {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, '../core/overlay-peer.ts'), '--overlays', '--popups'],
    requestTimeoutMs: 1_000,
  })
  try {
    const window = await app.openWindow({ title: 'React popup dismissal' })
    const seen: string[] = []
    const view = (probe: string) => (
      <box>
        <text>{probe}</text>
        <overlay
          anchor="parent"
          surface="window"
          style={{ width: 160, height: 96 }}
          onDismiss={(event: DismissRequestEvent) =>
            void seen.push(event.type + ':' + event.reason)
          }
        >
          <button>Copy</button>
        </overlay>
      </box>
    )
    const root = render(view(''), window)
    await root.ready
    root.render(view('event:' + JSON.stringify([{ type: 'dismiss', target: 'overlay#0' }])))
    const until = performance.now() + 2_000
    while (seen.length < 1 && performance.now() < until) await Bun.sleep(1)
    expect(seen).toEqual(['dismiss:window_blur'])
    await root.dispose()
    await window.close()
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics).toMatchObject({ windows: 0, nodes: 0, callbacks: 0 })
})
