import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LIMITS,
  type NativeEvent,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import fixtures from '../fixtures/native-services.json'

describe('shared native service boundary', () => {
  test('requires the current explicit service protocol', () => {
    expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
    expect(REQUIRED_CAPABILITIES.some((capability) => capability === fixtures.capability)).toBe(
      true
    )
  })

  for (const [kind, cases, parse] of [
    ['command', fixtures.commands, parseCommand],
    ['event', fixtures.events, parseEvent],
  ] as const)
    for (const item of cases)
      test(`${kind}: ${item.name}`, () => {
        const value: unknown = JSON.parse(item.wire)
        if (item.valid) expect(() => parse(value)).not.toThrow()
        else expect(() => parse(value)).toThrow()
      })

  test('native readiness cannot conceal or self-extend the immutable service policy', () => {
    const ready: Omit<Extract<NativeEvent, { type: 'ready' }>, 'service_policy'> = {
      type: 'ready',
      protocol: PROTOCOL_VERSION,
      capabilities: [...REQUIRED_CAPABILITIES],
      limits: DEFAULT_LIMITS,
    }
    for (const allowed of [false, true])
      expect(parseEvent({ ...ready, service_policy: { window_display: allowed } })).toEqual({
        ...ready,
        service_policy: { window_display: allowed },
      })
    for (const service_policy of [
      undefined,
      {},
      { window_display: null },
      { window_display: 1 },
      { window_display: 'allow' },
      { window_display: false, clipboard: true },
    ])
      expect(() => parseEvent({ ...ready, service_policy })).toThrow()
    expect(() =>
      parseEvent({ ...ready, protocol: 4, service_policy: { window_display: false } })
    ).toThrow('version mismatch')
  })

  test('nonfinite native display geometry is rejected before application delivery', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      for (const field of ['x', 'y', 'width', 'height'])
        expect(() =>
          parseEvent({
            type: 'display_snapshot',
            id: 1,
            window_id: 1,
            snapshot: {
              bounds: { x: 0, y: 0, width: 1, height: 1, [field]: value },
              scale_factor: 1,
            },
          })
        ).toThrow()
  })
})
