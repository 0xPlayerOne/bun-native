import { describe, expect, test } from 'bun:test'
import { parseElement, ProtocolError, SPLIT_DIVIDER } from '@bun-native/protocol'

const reject = (element: unknown) => expect(() => parseElement(element)).toThrow(ProtocolError)

describe('split pane style contract', () => {
  test('normalization supplies the documented defaults and keeps sizing and decoration', () => {
    expect(SPLIT_DIVIDER).toBe(6)
    expect(parseElement({ kind: 'split' })).toEqual({
      kind: 'split',
      ratio: 0.5,
      min_size: 0,
      style: {},
    })
    const style = {
      direction: 'column',
      padding: 4,
      width: 'fill',
      height: 300,
      min_width: 10,
      max_width: 900,
      flex_grow: 1,
      flex_shrink: 0,
      overflow: 'hidden',
      background: 0x101010,
      color: 0xffffff,
      font_size: 14,
      border_width: 1,
      border_color: 0x334455,
      corner_radius: 6,
      opacity: 0.5,
      font_weight: 600,
    } as const
    expect(parseElement({ kind: 'split', ratio: 1, min_size: 16_384, style })).toEqual({
      kind: 'split',
      ratio: 1,
      min_size: 16_384,
      style,
    })
    expect(parseElement({ kind: 'split', style: { overflow: 'visible' } })).toMatchObject({
      style: { overflow: 'visible' },
    })
  })

  test('pane placement fields are rejected, including zero and start values', () => {
    for (const style of [
      { gap: 0 },
      { align_items: 'start' },
      { justify_content: 'start' },
      { overflow: 'scroll_x' },
      { overflow: 'scroll_y' },
      { overflow: 'scroll' },
      { overflow: 'scroll_y', scroll_anchor: 'end' },
      { scroll_anchor: 'start' },
      { direction: 'horizontal' },
      { width: 'auto' },
    ])
      reject({ kind: 'split', style })
  })

  test('ratio and min_size are bounded finite numbers', () => {
    for (const fields of [
      { ratio: 1.0001 },
      { ratio: -0.0001 },
      { ratio: Number.NaN },
      { ratio: Number.POSITIVE_INFINITY },
      { ratio: '0.5' },
      { min_size: -1 },
      { min_size: 16_385 },
      { min_size: Number.NaN },
      { min_size: null },
      { panes: 2 },
    ])
      reject({ kind: 'split', ...fields })
  })
})

describe('scroll_anchor values and combinations', () => {
  test('start and end are accepted with vertical scrolling on boxes and overlays', () => {
    for (const kind of ['box', 'overlay'] as const)
      for (const overflow of ['scroll_y', 'scroll'] as const)
        for (const scroll_anchor of ['start', 'end'] as const)
          expect(parseElement({ kind, style: { overflow, scroll_anchor } }).style).toEqual({
            overflow,
            scroll_anchor,
          })
  })

  test('other values, horizontal or absent scrolling and leaf elements are rejected', () => {
    for (const scroll_anchor of ['center', 'END', 'bottom', '', null, 0, true])
      reject({ kind: 'box', style: { overflow: 'scroll_y', scroll_anchor } })
    for (const overflow of ['scroll_x', 'hidden', 'visible', undefined])
      for (const kind of ['box', 'overlay'])
        reject({ kind, style: { overflow, scroll_anchor: 'end' } })
    for (const element of [
      {
        kind: 'text',
        text: 'log',
        style: { overflow: 'scroll_y', scroll_anchor: 'end' },
      },
      { kind: 'text', text: 'log', style: { scroll_anchor: 'end' } },
      {
        kind: 'button',
        text: 'Go',
        style: { overflow: 'hidden', scroll_anchor: 'start' },
      },
      {
        kind: 'input',
        value: '',
        style: { overflow: 'scroll', scroll_anchor: 'end' },
      },
    ])
      reject(element)
  })
})
