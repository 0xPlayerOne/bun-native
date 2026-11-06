import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  defaultTheme,
  defineTheme,
  NativeStateError,
  UnsupportedFeatureError,
  type NativeApplication,
  type Style,
  type Theme,
} from '@bun-native/core'
import { createElement, createRenderRoot, insertNode, setProperty } from '@bun-native/renderer'

async function withApp(
  mode: 'normal' | 'layout-v2',
  run: (app: NativeApplication) => Promise<void>
) {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'protocol-peer.ts'), mode],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics.nodes).toBe(0)
}

const unsupported = (feature: string) => (error: unknown) =>
  error instanceof UnsupportedFeatureError && error.feature === feature

describe('optional layout capabilities', () => {
  test('a host without split_v1 or style_decoration_v1 rejects them before sending', () =>
    withApp('normal', async (app) => {
      expect(app.capabilities).not.toContain('split_v1')
      const window = await app.openWindow({ title: 'Older host' })
      await assert.rejects(
        window.batch((batch) => batch.create({ kind: 'split' })),
        unsupported('element:split')
      )
      for (const style of [
        { border_width: 1 },
        { border_color: 0 },
        { corner_radius: 2 },
        { opacity: 0.5 },
        { font_weight: 700 },
      ] satisfies Style[])
        await assert.rejects(
          window.batch((batch) => batch.create({ kind: 'box', style })),
          unsupported('style:decoration')
        )
      await assert.rejects(
        window.batch((batch) =>
          batch.set(window.root, { kind: 'box', style: { corner_radius: 4 } })
        ),
        unsupported('style:decoration')
      )
      expect(window.revision).toBe(0)
    }))

  test('a split owns at most two panes through core and the shared renderer', () =>
    withApp('layout-v2', async (app) => {
      expect(app.capabilities).toContain('split_v1')
      expect(app.capabilities).toContain('style_decoration_v1')
      const window = await app.openWindow({ title: 'Split host' })
      const split = await window.batch((batch) => {
        const node = batch.create({
          kind: 'split',
          ratio: 0.25,
          style: { direction: 'column', border_width: 1, corner_radius: 4, opacity: 0.9 },
        })
        batch.append(window.root, node)
        for (const text of ['one', 'two']) batch.append(node, batch.create({ kind: 'text', text }))
        return node
      })
      await assert.rejects(
        window.batch((batch) => batch.append(split, batch.create({ kind: 'text', text: 'three' }))),
        (error: unknown) => error instanceof NativeStateError && error.code === 'limit_exceeded'
      )
      await assert.rejects(
        window.batch((batch) => batch.set(split, { kind: 'split', style: { gap: 2 } } as never)),
        /gap or alignment/
      )
      expect(window.revision).toBe(1)

      const renderSplit = (panes: number, ratio: unknown) => {
        const node = createElement('split')
        setProperty(node, 'ratio', ratio)
        setProperty(node, 'min_size', 40)
        setProperty(node, 'style', { direction: 'row' })
        return createRenderRoot(window, ({ container }) => {
          insertNode(container, node)
          for (let index = 0; index < panes; index++) {
            const pane = createElement('box')
            insertNode(node, pane)
          }
        })
      }
      const valid = renderSplit(2, 0.75)
      await valid.ready
      expect(valid.diagnostics.nodes).toBe(4)
      await valid.dispose()
      const third = renderSplit(3, 0.5)
      await assert.rejects(third.ready, /at most two panes/)
      await assert.rejects(third.closed, /at most two panes/)
      expect(() => setProperty(createElement('box'), 'ratio', 0.5)).toThrow('Only splits')
      expect(() => setProperty(createElement('split'), 'ratio', '0.5')).toThrow('number')
      await window.close()
    }))
})

describe('theme tokens', () => {
  const dark = defineTheme({
    colors: { surface: 0x101418, text: 0xe8ecf0, accent: 0x5b8def },
    space: { sm: 6, md: 10 },
    radii: { md: 6 },
    fontSizes: { body: 16 },
  })

  test('tokens resolve to the plain native style before staging', () => {
    expect(
      dark.style({
        background: 'surface',
        color: 'text',
        border_color: 'accent',
        padding: 'md',
        gap: 'sm',
        corner_radius: 'md',
        font_size: 'body',
        border_width: 1,
        overflow: 'hidden',
      })
    ).toEqual({
      background: 0x101418,
      color: 0xe8ecf0,
      border_color: 0x5b8def,
      padding: 10,
      gap: 6,
      corner_radius: 6,
      font_size: 16,
      border_width: 1,
      overflow: 'hidden',
    })
    // Literal numbers pass through, so a style may mix tokens and values.
    expect(dark.style({ background: 0x123456, padding: 3 })).toEqual({
      background: 0x123456,
      padding: 3,
    })
    expect(Object.isFrozen(dark.tokens)).toBe(true)
    expect(Object.isFrozen(dark.tokens.colors)).toBe(true)
  })

  test('unknown tokens and invalid token values fail in JavaScript', () => {
    expect(() => dark.style({ background: 'missing' as 'surface' })).toThrow(
      'Unknown colors token for background: missing'
    )
    expect(() => dark.style({ padding: 'surface' as 'md' })).toThrow('Unknown space token')
    for (const tokens of [
      { colors: { bad: 0x1_000_000 }, space: {}, radii: {}, fontSizes: {} },
      { colors: { bad: 1.5 }, space: {}, radii: {}, fontSizes: {} },
      { colors: {}, space: { bad: -1 }, radii: {}, fontSizes: {} },
      { colors: {}, space: {}, radii: { bad: Number.NaN }, fontSizes: {} },
      { colors: {}, space: {}, radii: {} },
    ])
      expect(() => defineTheme(tokens as never)).toThrow(TypeError)
  })

  test('the default theme names the host primitive defaults', () => {
    expect(defaultTheme.tokens.colors).toMatchObject({
      surface: 0xffffff,
      text: 0x17212b,
      accent: 0x2255cc,
      disabled: 0x7a8396,
      divider: 0xc8ced8,
    })
    expect(defaultTheme.tokens.fontSizes.body).toBe(18)
  })

  test('switching themes is an ordinary batch on the same nodes', () =>
    withApp('layout-v2', async (app) => {
      const window = await app.openWindow({ title: 'Theme switch' })
      const panel = (theme: Theme) =>
        ({
          kind: 'box',
          style: theme.style({ background: 'surface', padding: 'md', corner_radius: 'md' }),
        }) as const
      const node = await window.batch((batch) => {
        const node = batch.create(panel(defaultTheme))
        batch.append(window.root, node)
        return node
      })
      await window.batch((batch) => batch.set(node, panel(dark)))
      expect(window.revision).toBe(2)
      await window.close()
    }))
})
