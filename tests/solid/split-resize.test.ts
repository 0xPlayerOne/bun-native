import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  createApplication,
  type DismissRequestEvent,
  type SplitResizeEvent,
} from '@bun-native/core'
import { createElement, insert, insertNode, render, setProp } from '@bun-native/solid'
import { createSignal } from 'solid-js'

test('Solid onSplitResize receives the host-owned ratio and its source', async () => {
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
    const window = await app.openWindow({ title: 'Solid split resize' })
    const seen: Array<[number, string]> = []
    const [probe, setProbe] = createSignal('')
    const root = render(() => {
      const box = createElement('box')
      const text = createElement('text')
      insert(text, probe)
      const split = createElement('split')
      setProp(split, 'accessibleLabel', 'Sidebar')
      setProp(split, 'onSplitResize', (event: SplitResizeEvent) =>
        seen.push([event.ratio, event.source])
      )
      insertNode(split, createElement('box'))
      insertNode(split, createElement('box'))
      insertNode(box, text)
      insertNode(box, split)
      return box
    }, window)
    await root.ready
    setProbe(
      'event:' +
        JSON.stringify([
          { type: 'split_resize', target: 'split#0', ratio: 0.7, source: 'keyboard' },
        ])
    )
    const until = performance.now() + 2_000
    while (seen.length < 1 && performance.now() < until) await Bun.sleep(1)
    expect(seen).toEqual([[0.7, 'keyboard']])
    await root.dispose()
    await window.close()
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics).toMatchObject({ windows: 0, nodes: 0, callbacks: 0 })
})

test('Solid onDismiss observes a popup window losing its parent focus', async () => {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, '../core/overlay-peer.ts'), '--overlays', '--popups'],
    requestTimeoutMs: 1_000,
  })
  try {
    const window = await app.openWindow({ title: 'Solid popup dismissal' })
    const seen: string[] = []
    const [probe, setProbe] = createSignal('')
    const root = render(() => {
      const box = createElement('box')
      const text = createElement('text')
      insert(text, probe)
      const overlay = createElement('overlay')
      setProp(overlay, 'anchor', 'parent')
      setProp(overlay, 'surface', 'window')
      setProp(overlay, 'style', { width: 160, height: 96 })
      setProp(overlay, 'onDismiss', (event: DismissRequestEvent) =>
        seen.push(event.type + ':' + event.reason)
      )
      insertNode(overlay, createElement('box'))
      insertNode(box, text)
      insertNode(box, overlay)
      return box
    }, window)
    await root.ready
    setProbe('event:' + JSON.stringify([{ type: 'dismiss', target: 'overlay#0' }]))
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
