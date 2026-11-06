import { describe, expect, test } from 'bun:test'
import { parseEvent, ProtocolError } from '@bun-native/protocol'

const bounds = { x: 0, y: 0, width: 1280, height: 800 }
const response = (snapshot: unknown) => ({
  type: 'display_snapshot',
  id: 1,
  window_id: 1,
  snapshot,
})
const change = (snapshot: unknown, sequence: unknown = 1) => ({
  type: 'display_changed',
  sequence,
  window_id: 1,
  snapshot,
})

describe('display snapshot wire limits', () => {
  test.each([0.125, 1, 16])('scale factor %p is inside the accepted range', (scale_factor) => {
    expect(parseEvent(response({ bounds, scale_factor }))).toMatchObject({
      snapshot: { scale_factor },
    })
  })

  test.each([-1_048_576, 1_048_576])('an origin of %p is accepted', (x) => {
    expect(parseEvent(response({ bounds: { ...bounds, x, y: x }, scale_factor: 1 }))).toMatchObject(
      { snapshot: { bounds: { x, y: x } } }
    )
  })

  test.each([
    ['an origin past the bound', { ...bounds, x: 1_048_577 }],
    ['a width past the bound', { ...bounds, width: 1_048_577 }],
    ['a zero height', { ...bounds, height: 0 }],
    ['a negative width', { ...bounds, width: -1 }],
    ['a string coordinate', { ...bounds, y: '0' }],
    ['a missing field', { x: 0, y: 0, width: 1 }],
  ])('%s is rejected', (_, value) => {
    expect(() => parseEvent(response({ bounds: value, scale_factor: 1 }))).toThrow(ProtocolError)
  })

  test('a work area obeys the same geometry bounds as the display', () => {
    expect(() =>
      parseEvent(
        response({ bounds, scale_factor: 1, visible_bounds: { ...bounds, x: -1_048_577 } })
      )
    ).toThrow(ProtocolError)
  })

  test.each([
    ['too long', '37d8832a-2d66-02ca-b9f7-8f30a301b2300'],
    ['too short', '37d8832a-2d66-02ca-b9f7-8f30a301b23'],
    ['braced', '{37d8832a-2d66-02ca-b9f7-8f30a301b2}'],
    ['non-hex', '37d8832a-2d66-02ca-b9f7-8f30a301b23g'],
    ['a number', 1],
    ['empty', ''],
  ])('a display UUID that is %s is rejected', (_, display_uuid) => {
    expect(() =>
      parseEvent(response({ bounds, scale_factor: 1, visible_bounds: bounds, display_uuid }))
    ).toThrow(ProtocolError)
  })
})

describe('display_changed events', () => {
  test('carry the full detailed snapshot', () => {
    const snapshot = {
      bounds,
      scale_factor: 2,
      visible_bounds: { ...bounds, y: 25, height: 775 },
      display_uuid: '37d8832a-2d66-02ca-b9f7-8f30a301b230',
    }
    expect(parseEvent(change(snapshot, 7))).toEqual({
      type: 'display_changed',
      sequence: 7,
      window_id: 1,
      snapshot,
    })
  })

  test.each([0, -1, 1.5, '1', null])('reject sequence %p', (sequence) => {
    expect(() => parseEvent(change({ bounds, scale_factor: 1 }, sequence))).toThrow()
  })

  test('reject an unknown field and a missing snapshot', () => {
    expect(() => parseEvent({ ...change({ bounds, scale_factor: 1 }), display: 1 })).toThrow(
      ProtocolError
    )
    const { snapshot: _, ...missing } = change({ bounds, scale_factor: 1 })
    expect(() => parseEvent(missing)).toThrow()
  })
})
