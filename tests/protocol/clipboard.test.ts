import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LIMITS,
  encodeFrame,
  MAX_CLIPBOARD_BYTES,
  MAX_FRAME_BYTES,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type NativeEvent,
} from '@bun-native/protocol'
import fixtures from '../fixtures/native-clipboard.json'

describe('shared clipboard wire contract (headless)', () => {
  test('clipboard is an optional implemented capability, independent of read and write grants', () => {
    expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
    expect(fixtures.capability).toBe('clipboard_text_v1')
    for (const clipboard_read of [false, true])
      for (const clipboard_write of [false, true]) {
        const ready = {
          type: 'ready',
          protocol: PROTOCOL_VERSION,
          capabilities: [...REQUIRED_CAPABILITIES, 'clipboard_text_v1'],
          limits: DEFAULT_LIMITS,
          service_policy: { window_display: false, clipboard_read, clipboard_write },
        } satisfies NativeEvent
        expect(parseEvent(ready)).toEqual(ready)
        expect(parseEvent({ ...ready, capabilities: [...REQUIRED_CAPABILITIES] })).toEqual({
          ...ready,
          capabilities: [...REQUIRED_CAPABILITIES],
        })
        for (const key of ['clipboard_read', 'clipboard_write']) {
          expect(() =>
            parseEvent({ ...ready, service_policy: { ...ready.service_policy, [key]: undefined } })
          ).toThrow()
          expect(() =>
            parseEvent({ ...ready, service_policy: { ...ready.service_policy, [key]: 'allow' } })
          ).toThrow()
        }
        expect(() => parseEvent({ ...ready, protocol: 5 })).toThrow('version mismatch')
      }
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

  test('UTF-8 byte caps and worst-case JSON escaping remain below the frame cap', () => {
    for (const text of [
      'é'.repeat(MAX_CLIPBOARD_BYTES / 2),
      '\u0001'.repeat(MAX_CLIPBOARD_BYTES),
    ]) {
      const command = parseCommand({ type: 'clipboard_write', id: 1, window_id: 1, text })
      const event = parseEvent({
        type: 'clipboard_text',
        id: 1,
        window_id: 1,
        result: { kind: 'text', text },
      })
      expect(encodeFrame(command).byteLength - 1).toBeLessThan(MAX_FRAME_BYTES)
      expect(encodeFrame(event).byteLength - 1).toBeLessThan(MAX_FRAME_BYTES)
      expect(() => parseCommand({ ...command, text: text + 'x' })).toThrow()
      expect(() => parseEvent({ ...event, result: { kind: 'text', text: text + 'x' } })).toThrow()
    }
  })
})
