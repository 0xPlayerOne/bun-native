import { describe, expect, test } from 'bun:test'
import { parseElement, ProtocolError } from '@bun-native/protocol'

const reject = (element: unknown) => expect(() => parseElement(element)).toThrow(ProtocolError)

describe('overlay field combinations', () => {
  test('explicit defaults normalize to the minimal wire form', () => {
    expect(
      parseElement({
        kind: 'overlay',
        anchor: 'window',
        modal: false,
        surface: 'layer',
        autofocus: false,
        navigation: 'tab',
      })
    ).toEqual({ kind: 'overlay', anchor: 'window', modal: false, style: {} })
    expect(parseElement({ kind: 'overlay', anchor: 'parent', modal: false })).toEqual({
      kind: 'overlay',
      anchor: 'parent',
      modal: false,
      style: {},
    })
    // A modal window overlay may also be a keyboard menu.
    expect(
      parseElement({
        kind: 'overlay',
        modal: true,
        autofocus: true,
        navigation: 'menu',
      })
    ).toEqual({
      kind: 'overlay',
      anchor: 'window',
      modal: true,
      autofocus: true,
      navigation: 'menu',
      style: {},
    })
  })

  test('a popup accepts explicit keyboard defaults and the one-pixel minimum size', () => {
    expect(
      parseElement({
        kind: 'overlay',
        anchor: 'parent',
        modal: false,
        surface: 'window',
        autofocus: false,
        navigation: 'tab',
        style: {
          width: 1,
          height: 1,
          overflow: 'scroll_y',
          scroll_anchor: 'end',
        },
      })
    ).toEqual({
      kind: 'overlay',
      anchor: 'parent',
      modal: false,
      surface: 'window',
      style: {
        width: 1,
        height: 1,
        overflow: 'scroll_y',
        scroll_anchor: 'end',
      },
    })
  })

  test('invalid combinations are rejected', () => {
    for (const element of [
      { kind: 'overlay', anchor: 'parent', modal: true },
      { kind: 'overlay', anchor: 'parent', modal: true, autofocus: true },
      { kind: 'overlay', surface: 'window', style: { width: 10, height: 10 } },
      {
        kind: 'overlay',
        anchor: 'window',
        surface: 'window',
        style: { width: 10, height: 10 },
      },
      {
        kind: 'overlay',
        anchor: 'parent',
        modal: true,
        surface: 'window',
        style: { width: 10, height: 10 },
      },
      {
        kind: 'overlay',
        anchor: 'parent',
        surface: 'window',
        style: { width: 10, height: 0 },
      },
      {
        kind: 'overlay',
        anchor: 'parent',
        surface: 'window',
        style: { width: 0.5, height: 10 },
      },
      {
        kind: 'overlay',
        anchor: 'parent',
        surface: 'window',
        style: { width: 10, height: 'fill' },
      },
      { kind: 'overlay', anchor: 'parent', surface: 'window' },
      {
        kind: 'overlay',
        anchor: 'parent',
        surface: 'window',
        navigation: 'menu',
        style: { width: 10, height: 10 },
      },
      { kind: 'overlay', anchor: null },
      { kind: 'overlay', autofocus: 'true' },
      { kind: 'overlay', navigation: 'grid' },
      { kind: 'overlay', surface: 'popup' },
      { kind: 'overlay', children: [] },
    ])
      reject(element)
  })
})
