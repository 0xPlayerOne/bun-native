/** @jsxImportSource @bun-native/react */
import { expect, test } from 'bun:test'
import type { Element, NativeBatch, NativeNode, NativeWindow, Style } from '@bun-native/core'
import { render, type NativeRef } from '@bun-native/react'
import { asNode } from '@bun-native/renderer'

/** An in-process window that records every native set and acknowledges it. */
function recordingWindow() {
  const sets: Element[] = []
  let id = 0
  const handle = (kind: string) => ({ kind, id: id++ }) as unknown as NativeNode
  const batch: NativeBatch = {
    create: (element) => handle(element.kind) as never,
    set: (_node: NativeNode, element: Element) => {
      sets.push(element)
    },
    insert: () => {},
    append: () => {},
    remove: () => {},
    focus: () => {},
    scrollTo: () => {},
    scrollIntoView: () => {},
  } as NativeBatch
  const window = {
    root: handle('box'),
    closed: new Promise<void>(() => {}),
    revision: 0,
    batch: async (update: (batch: NativeBatch) => unknown) => update(batch),
    on: () => () => {},
    input: () => ({ value: '', revision: 0 }),
    close: async () => {},
  } as unknown as NativeWindow
  return { window, sets }
}

test('React inline styles equal to the previous render send no native set', async () => {
  const { window, sets } = recordingWindow()
  let box: NativeRef | undefined
  // Explicit undefined values are allowed here to reach the renderer unchanged.
  const view = (style: { [Key in keyof Style]?: Style[Key] | undefined }, label: string) => (
    <box
      ref={(node: NativeRef | null) => void (box = node ?? undefined)}
      style={{ ...style } as Style}
    >
      <text style={{ color: 0x202020 }}>{label}</text>
    </box>
  )
  const root = render(view({ gap: 4, padding: 2 }, 'a'), window)
  await root.ready
  // New objects, same keys and values: the node keeps its committed capture,
  // so the renderer neither recaptures it nor sends a native set.
  const captured = asNode(box!).captured
  expect(captured).toBeDefined()
  await root.render(view({ gap: 4, padding: 2 }, 'a'))
  await root.render(view({ gap: 4, padding: 2 }, 'a'))
  expect(sets).toEqual([])
  expect(asNode(box!).captured).toBe(captured)
  // Reordered keys reach the renderer, which compares values, not their order.
  await root.render(view({ padding: 2, gap: 4 }, 'a'))
  expect(sets).toEqual([])
  // A changed value, a removed key and an added key each set the new style.
  await root.render(view({ gap: 8, padding: 2 }, 'a'))
  await root.render(view({ gap: 8 }, 'a'))
  await root.render(view({ gap: 8, width: 'fill' }, 'a'))
  // An explicit undefined reaches the renderer, which commits the same element.
  await root.render(view({ gap: 8, width: 'fill', padding: undefined }, 'a'))
  expect(sets.map((element) => element.style)).toEqual([
    { gap: 8, padding: 2 },
    { gap: 8 },
    { gap: 8, width: 'fill' },
  ])
  // Text still updates while its equal inline style is skipped.
  sets.length = 0
  await root.render(view({ gap: 8, width: 'fill', padding: undefined }, 'b'))
  expect(sets).toEqual([{ kind: 'text', text: 'b', style: { color: 0x202020 } }])
  await root.dispose()
})

test('React style removal and replacement with a non-object still reach the renderer', async () => {
  const { window, sets } = recordingWindow()
  const root = render(<box style={{ gap: 4 }} />, window)
  await root.ready
  await root.render(<box />)
  expect(sets).toEqual([{ kind: 'box' }])
  await root.render(<box style={{ gap: 4 }} />)
  expect(() => root.render(<box style={[] as never} />)).toThrow('Native style must be an object')
  await root.dispose().catch(() => {})
})
