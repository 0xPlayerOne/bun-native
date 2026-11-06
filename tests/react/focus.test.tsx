/** @jsxImportSource @bun-native/react */
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createApplication, NativeStateError, UnsupportedFeatureError } from '@bun-native/core'
import {
  focusNode,
  render,
  scrollNodeIntoView,
  scrollNodeTo,
  type NativeRef,
} from '@bun-native/react'
import { createElement, setProperty, snapshot } from '../../packages/renderer/src/nodes.ts'

async function withPeer(
  keyboard: boolean,
  run: (app: Awaited<ReturnType<typeof createApplication>>) => Promise<void>
) {
  const app = await createApplication({
    executable: process.execPath,
    args: [
      resolve(import.meta.dir, '../core/overlay-peer.ts'),
      '--overlays',
      ...(keyboard ? ['--keyboard'] : []),
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

test('overlay keyboard properties validate and reach the native element only when set', () => {
  const overlay = createElement('overlay')
  setProperty(overlay, 'autofocus', true)
  setProperty(overlay, 'navigation', 'menu')
  expect(snapshot(overlay).get(overlay)?.element).toEqual({
    kind: 'overlay',
    autofocus: true,
    navigation: 'menu',
  })
  setProperty(overlay, 'autofocus', undefined)
  setProperty(overlay, 'navigation', undefined)
  expect(snapshot(overlay).get(overlay)?.element).toEqual({ kind: 'overlay' })
  for (const [node, name, value] of [
    [overlay, 'autofocus', 'yes'],
    [overlay, 'navigation', 'grid'],
    [createElement('box'), 'autofocus', true],
    [createElement('button'), 'navigation', 'menu'],
  ] as const)
    expect(() => setProperty(node, name, value)).toThrow(TypeError)
})

test('React refs focus and scroll committed native nodes after staged changes flush', () =>
  withPeer(true, async (app) => {
    const window = await app.openWindow({ title: 'React focus' })
    const refs: Record<string, NativeRef> = {}
    const focused: string[] = []
    const keep = (name: string) => (value: NativeRef | null) => {
      if (value) refs[name] = value
    }
    const root = render(
      <box>
        <box ref={keep('list')} style={{ overflow: 'scroll_y', height: 40 }}>
          <button ref={keep('first')} onFocus={() => void focused.push('first')}>
            First
          </button>
          <text ref={keep('row')}>Row</text>
        </box>
        <overlay anchor="parent" autofocus navigation="menu">
          <button ref={keep('item')} onFocus={() => void focused.push('item')}>
            Item
          </button>
        </overlay>
      </box>,
      window
    )
    await root.ready
    await focusNode(refs['item']!)
    await focusNode(refs['first']!)
    await scrollNodeTo(refs['list']!, { y: 12 })
    await scrollNodeIntoView(refs['row']!)
    const until = performance.now() + 2_000
    while (focused.length < 2 && performance.now() < until) await Bun.sleep(1)
    expect(focused).toEqual(['item', 'first'])
    expect(() => focusNode(refs['row']!)).toThrow(NativeStateError)
    expect(() => scrollNodeTo(refs['first']!, { y: 1 })).toThrow(NativeStateError)
    await root.dispose()
    expect(() => focusNode(refs['first']!)).toThrow(NativeStateError)
    await window.close()
  }))

test('React focus requests fail locally on a host without focus_v1', () =>
  withPeer(false, async (app) => {
    const window = await app.openWindow({ title: 'React no focus' })
    let button: NativeRef | undefined
    const root = render(
      <button
        ref={(value: NativeRef | null) => {
          if (value) button = value
        }}
      >
        Plain
      </button>,
      window
    )
    await root.ready
    await assert.rejects(
      focusNode(button!),
      (error: unknown) =>
        error instanceof UnsupportedFeatureError && error.feature === 'operation:focus'
    )
    await root.dispose()
    await window.close()
  }))
