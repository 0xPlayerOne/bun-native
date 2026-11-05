import { describe, expect, test } from 'bun:test'
import {
  digest,
  historyText,
  STREAMING_LIST_FIXTURE,
  streamToken,
} from '../../benchmarks/streaming-list-fixture.ts'
import {
  DENSITIES,
  FRAME_NODES,
  MAX_ROWS,
  NODES_PER_ROW,
  StreamingList,
  listStyle,
  rowStyle,
  THEMES,
} from '../native/streaming-list-model.ts'

const ids = (list: StreamingList) => list.view().rows.map((row) => row.id)

describe('versioned streaming fixture', () => {
  test('content is a pure function of indices', () => {
    expect(historyText(42)).toBe(historyText(42))
    expect(historyText(42).split(' ')).toHaveLength(STREAMING_LIST_FIXTURE.historyWords)
    expect(streamToken(0).startsWith(' ')).toBe(false)
    expect(streamToken(1).startsWith(' ')).toBe(true)
    expect(streamToken(STREAMING_LIST_FIXTURE.tokensPerMessage).startsWith(' ')).toBe(false)
    expect(digest(['a', 'b'])).not.toBe(digest(['ab']))
    expect(digest(['a', 'b'])).toMatch(/^[0-9a-f]{8}$/)
  })

  test('the history exceeds the native per-window node limit', () => {
    // Mounting every message would need far more than 4,096 native nodes.
    expect(STREAMING_LIST_FIXTURE.historyMessages * NODES_PER_ROW).toBeGreaterThan(4_096)
    expect(FRAME_NODES + MAX_ROWS * NODES_PER_ROW).toBeLessThan(64)
  })
})

describe('app-level windowing model', () => {
  test('a following view tails the stream and selects the newest message', () => {
    const list = new StreamingList(100)
    expect(ids(list)).toEqual(Array.from({ length: 9 }, (_, index) => 92 + index))
    for (let tick = 0; tick < STREAMING_LIST_FIXTURE.tokensPerMessage + 1; tick++) list.stream()
    const view = list.view()
    expect(view.total).toBe(102)
    expect(view.follow).toBe(true)
    expect(view.selected).toBe(102)
    expect(view.rows.at(-1)).toMatchObject({ id: 102, streaming: true })
    expect(view.rows.at(-2)).toMatchObject({ id: 101, streaming: false })
    expect(view.rows.at(-2)?.text.split(' ')).toHaveLength(STREAMING_LIST_FIXTURE.tokensPerMessage)
    expect(view.rows.length).toBe(DENSITIES.comfortable.rows)
  })

  test('a detached anchor and selection survive any number of appends', () => {
    const list = new StreamingList(100)
    expect(list.key('up')).toBe(true)
    const before = list.view()
    expect(before).toMatchObject({ follow: false, selected: 99 })
    for (let tick = 0; tick < 200; tick++) list.stream()
    const after = list.view()
    expect(after.total).toBeGreaterThan(before.total)
    expect(after.anchor).toBe(before.anchor)
    expect(after.selected).toBe(99)
    expect(after.rows.map((row) => row.id)).toEqual(before.rows.map((row) => row.id))
    list.key('end')
    expect(list.view()).toMatchObject({ follow: true, selected: list.total })
  })

  test('keyboard navigation keeps the selection visible and clamps at both ends', () => {
    const list = new StreamingList(50)
    list.key('home')
    expect(list.view()).toMatchObject({ anchor: 0, selected: 1 })
    list.key('up')
    expect(list.view()).toMatchObject({ anchor: 0, selected: 1 })
    for (let step = 0; step < 9; step++) list.key('down')
    expect(list.view()).toMatchObject({ anchor: 1, selected: 10 })
    list.key('pagedown')
    expect(list.view().selected).toBe(19)
    expect(ids(list)).toContain(19)
    list.key('pageup')
    list.key('pageup')
    expect(list.view()).toMatchObject({ anchor: 0, selected: 1 })
    for (let step = 0; step < 10; step++) list.key('pagedown')
    expect(list.view()).toMatchObject({ anchor: 41, selected: 50 })
    expect(list.key('a')).toBe(false)
  })

  test('pointer selection accepts only visible rows', () => {
    const list = new StreamingList(50)
    expect(list.select(1)).toBe(false)
    expect(list.select(45)).toBe(true)
    expect(list.view()).toMatchObject({ follow: false, selected: 45 })
    expect(list.select(51)).toBe(false)
  })

  test('density changes the window size and keeps the selection in view', () => {
    const list = new StreamingList(100)
    list.key('f8')
    expect(list.view()).toMatchObject({ density: 'compact', anchor: 100 - 14, follow: true })
    list.key('home')
    for (let step = 0; step < 13; step++) list.key('down')
    list.key('f8')
    const view = list.view()
    expect(view.density).toBe('comfortable')
    expect(view.rows.map((row) => row.id)).toContain(view.selected!)
    expect(view.rows).toHaveLength(9)
  })

  test('theme and density tokens flow into shared native styles', () => {
    const list = new StreamingList(20)
    const dark = list.view()
    list.key('f7')
    list.key('f8')
    const light = list.view()
    const row = light.rows.at(-1)!
    expect(rowStyle(dark, dark.rows.at(-1)!).background).toBe(THEMES.dark.selected)
    expect(rowStyle(light, row)).toMatchObject({
      background: THEMES.light.selected,
      height: DENSITIES.compact.rowHeight,
      padding: DENSITIES.compact.rowPadding,
    })
    expect(listStyle(light).justify_content).toBe('end')
    list.key('up')
    expect(listStyle(list.view()).justify_content).toBe('start')
  })

  test('two models replay the complete stream to the same digest', () => {
    const first = new StreamingList(10)
    const second = new StreamingList(10)
    while (first.stream());
    while (second.stream());
    expect(first.tick).toBe(STREAMING_LIST_FIXTURE.ticks)
    expect(first.stream()).toBe(false)
    expect(first.total).toBe(
      10 + Math.ceil(STREAMING_LIST_FIXTURE.ticks / STREAMING_LIST_FIXTURE.tokensPerMessage)
    )
    expect(first.view().rows.every((entry) => !entry.streaming)).toBe(true)
    expect(first.digest()).toBe(second.digest())
  })
})
