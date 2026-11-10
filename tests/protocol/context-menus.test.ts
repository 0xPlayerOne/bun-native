import {
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
  DEFAULT_LIMITS,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import { describe, expect, test } from 'bun:test'
import fixtures from '../fixtures/native-context-menus.json'

describe('shared context menu wire contract (headless)', () => {
  test('context menus are an optional capability of this protocol version', () => {
    expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
    expect(fixtures.capability).toBe('context_menus_v1')
    expect(REQUIRED_CAPABILITIES).not.toContain('context_menus_v1' as never)
    const ready = {
      type: 'ready',
      protocol: PROTOCOL_VERSION,
      capabilities: [...REQUIRED_CAPABILITIES, 'context_menus_v1'],
      limits: DEFAULT_LIMITS,
      service_policy: {
        window_display: false,
        clipboard_read: false,
        clipboard_write: false,
        global_shortcuts: false,
        notifications: false,
        drag_drop: false,
        filesystem_roots: [],
        processes: [],
      },
    }
    expect(parseEvent(ready)).toEqual(ready as never)
  })

  for (const [kind, cases, parse] of [
    ['command', fixtures.commands, parseCommand],
    ['event', fixtures.events, parseEvent],
  ] as const)
    for (const item of cases)
      test(`${kind}: ${item.name}`, () => {
        const value: unknown = JSON.parse(item.wire)
        if (item.valid) expect(parse(value)).toEqual(value as never)
        else expect(() => parse(value)).toThrow()
      })
})
