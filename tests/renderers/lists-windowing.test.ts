import { describe, expect, test } from 'bun:test'
import { STREAMING_LIST_FIXTURE } from '../../benchmarks/streaming-list-fixture.ts'
import {
  DENSITIES,
  FRAME_NODES,
  LISTENERS_PER_ROW,
  MAX_ROWS,
  NAVIGATION_KEYS,
  NODES_PER_ROW,
  StreamingList,
  type DensityName,
} from '../native/streaming-list-model.ts'

const ids = (list: StreamingList) => list.view().rows.map((row) => row.id)
const range = (first: number, count: number) =>
  Array.from({ length: count }, (_, index) => first + index)
const { tokensPerMessage } = STREAMING_LIST_FIXTURE

function withDensity(list: StreamingList, density: DensityName) {
  while (list.view().density !== density) list.key('f8')
  return list
}

describe('windowing bounds', () => {
  test('the window never exceeds the density row count and starts at zero for short histories', () => {
    for (const density of ['comfortable', 'compact'] as const) {
      const rows = DENSITIES[density].rows
      for (const history of [1, rows - 1, rows, rows + 1, 100]) {
        const list = withDensity(new StreamingList(history), density)
        const view = list.view()
        expect(view.rows).toHaveLength(Math.min(history, rows))
        expect(view.anchor).toBe(Math.max(0, history - rows))
        expect(view.rows.at(-1)?.id).toBe(history)
        // Every navigation key keeps the window inside the history.
        for (const key of NAVIGATION_KEYS) {
          list.key(key)
          const next = list.view()
          const size = DENSITIES[next.density].rows
          expect(next.anchor).toBeGreaterThanOrEqual(0)
          expect(next.anchor).toBeLessThanOrEqual(Math.max(0, history - size))
          expect(next.rows).toHaveLength(Math.min(history, size))
        }
      }
    }
  })

  test('the native node and listener bounds follow from the largest density', () => {
    expect(MAX_ROWS).toBe(DENSITIES.compact.rows)
    expect(FRAME_NODES + MAX_ROWS * NODES_PER_ROW).toBe(51)
    expect(MAX_ROWS * LISTENERS_PER_ROW).toBe(14)
  })

  test('the status line names the 1-based visible range and the follow state', () => {
    const list = new StreamingList(30)
    expect(list.view().status).toBe('30 messages · rows 22–30 · following · tick 0')
    list.key('home')
    expect(list.view().status).toBe('30 messages · rows 1–9 · detached · tick 0')
    list.stream()
    expect(list.view().status).toBe('31 messages · rows 1–9 · detached · tick 1')
  })

  test('an empty history has no selection, ignores navigation and selects the first stream', () => {
    const list = new StreamingList(0)
    expect(list.view()).toMatchObject({ rows: [], anchor: 0, total: 0, selected: null })
    for (const key of NAVIGATION_KEYS) expect(list.key(key)).toBe(true)
    // The key sequence ends with End, F7 and F8, so the empty view still follows.
    expect(list.view()).toMatchObject({ anchor: 0, selected: null, follow: true })
    expect(list.select(1)).toBe(false)
    list.stream()
    expect(list.view()).toMatchObject({ total: 1, selected: 1, follow: true })
    expect(list.view().rows).toEqual([
      expect.objectContaining({ id: 1, streaming: true, selected: true }),
    ])
  })

  test('views are frozen snapshots and keys outside the contract are ignored', () => {
    const list = new StreamingList(20)
    const view = list.view()
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.rows)).toBe(true)
    for (const key of ['', 'Up', 'UP', 'left', 'enter', 'f9', 'tab'])
      expect(list.key(key)).toBe(false)
    expect(list.view()).toEqual(view)
  })
})

describe('index anchor', () => {
  test('page keys move the window and the selection by one page', () => {
    const list = new StreamingList(50)
    list.key('home')
    for (let step = 0; step < 20; step++) list.key('down')
    expect(list.view()).toMatchObject({ anchor: 12, selected: 21 })
    list.key('pageup')
    expect(list.view()).toMatchObject({ anchor: 3, selected: 12 })
    list.key('pagedown')
    expect(list.view()).toMatchObject({ anchor: 12, selected: 21 })
    // At the top, PageUp clamps both the anchor and the selection.
    list.key('pageup')
    list.key('pageup')
    expect(list.view()).toMatchObject({ anchor: 0, selected: 3 })
    list.key('pageup')
    expect(list.view()).toMatchObject({ anchor: 0, selected: 1 })
  })

  test('reaching the newest message by navigation stays detached until End', () => {
    const list = new StreamingList(30)
    list.key('up')
    list.key('pagedown')
    list.key('down')
    expect(list.view()).toMatchObject({ anchor: 21, selected: 30, follow: false })
    for (let tick = 0; tick < tokensPerMessage + 1; tick++) list.stream()
    // Two streamed messages arrived below the detached window.
    expect(list.view()).toMatchObject({ total: 32, anchor: 21, selected: 30, follow: false })
    expect(ids(list)).toEqual(range(22, 9))
    list.key('end')
    expect(list.view()).toMatchObject({ anchor: 23, selected: 32, follow: true })
    expect(ids(list)).toEqual(range(24, 9))
  })

  test('a detached anchor holds while streamed messages complete and new ones open', () => {
    const list = new StreamingList(40)
    list.key('pageup')
    const before = list.view()
    expect(before).toMatchObject({ anchor: 22, selected: 31, follow: false })
    for (let tick = 0; tick < tokensPerMessage * 3; tick++) {
      list.stream()
      const view = list.view()
      expect(view.anchor).toBe(before.anchor)
      expect(view.selected).toBe(before.selected)
      expect(view.rows).toEqual(before.rows)
    }
    expect(list.total).toBe(43)
  })

  test('a following window shifts by exactly one row only when a message opens', () => {
    const list = new StreamingList(20)
    let previous = ids(list)
    for (let tick = 0; tick < tokensPerMessage * 2; tick++) {
      list.stream()
      const next = ids(list)
      if (tick % tokensPerMessage === 0) {
        // One message leaves the head and the newly opened one joins the tail.
        expect(next.slice(0, -1)).toEqual(previous.slice(1))
        expect(next.at(-1)).toBe(previous.at(-1)! + 1)
      } else expect(next).toEqual(previous)
      expect(list.view().selected).toBe(next.at(-1)!)
      previous = next
    }
  })

  test('the theme toggle never moves the anchor, selection or follow state', () => {
    const list = new StreamingList(40)
    list.key('pageup')
    const before = list.view()
    list.key('f7')
    expect(list.view()).toEqual({ ...before, theme: 'light' })
    list.key('f7')
    expect(list.view()).toEqual(before)
  })

  test('a detached density switch reveals the selection at either edge of the window', () => {
    const list = withDensity(new StreamingList(60), 'compact')
    list.key('home')
    for (let step = 0; step < 13; step++) list.key('down')
    // Compact: rows 1–14, selection at the bottom edge.
    expect(list.view()).toMatchObject({ anchor: 0, selected: 14 })
    list.key('f8')
    expect(list.view()).toMatchObject({ density: 'comfortable', anchor: 5, selected: 14 })
    list.key('f8')
    // Growing the window keeps the anchor; the selection was already visible.
    expect(list.view()).toMatchObject({ density: 'compact', anchor: 5, selected: 14 })
    list.key('end')
    list.key('f8')
    expect(list.view()).toMatchObject({ density: 'comfortable', anchor: 51, follow: true })
  })
})

describe('id-based selection', () => {
  test('the selected flag follows the message id, not the row position', () => {
    const list = new StreamingList(40)
    list.key('pageup')
    expect(list.select(25)).toBe(true)
    const marked = () =>
      list
        .view()
        .rows.filter((row) => row.selected)
        .map((row) => row.id)
    expect(marked()).toEqual([25])
    const position = ids(list).indexOf(25)
    // Shrinking the window removes rows; the selection keeps its id and stays visible.
    list.key('f8')
    list.key('f8')
    expect(marked()).toEqual([25])
    for (let tick = 0; tick < 50; tick++) list.stream()
    expect(marked()).toEqual([25])
    expect(ids(list).indexOf(25)).toBe(position)
  })

  test('pointer selection rejects rows outside the current window and non-messages', () => {
    const list = new StreamingList(40)
    list.key('home')
    expect(list.select(10)).toBe(false)
    expect(list.select(0)).toBe(false)
    expect(list.select(-1)).toBe(false)
    expect(list.select(9)).toBe(true)
    expect(list.view()).toMatchObject({ anchor: 0, selected: 9 })
    // The window moves with the keyboard, and the old rows become unselectable.
    list.key('end')
    expect(list.select(9)).toBe(false)
    expect(list.view()).toMatchObject({ selected: 40, follow: true })
    expect(list.select(35)).toBe(true)
    expect(list.view()).toMatchObject({ selected: 35, follow: false, anchor: 31 })
  })

  test('navigation from a pointer selection starts at the selected id', () => {
    const list = new StreamingList(40)
    list.select(33)
    list.key('down')
    expect(list.view().selected).toBe(34)
    list.key('up')
    list.key('up')
    expect(list.view()).toMatchObject({ selected: 32, anchor: 31 })
  })
})
