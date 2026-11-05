import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LIMITS,
  GLOBAL_SHORTCUT_KEYS,
  MAX_GLOBAL_SHORTCUTS,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type NativeEvent,
} from '@bun-native/protocol'
import fixtures from '../fixtures/native-global-shortcuts.json'

describe('shared global shortcut wire contract (headless)', () => {
  test('global shortcuts are an optional capability with an explicit grant', () => {
    expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
    expect(fixtures.capability).toBe('global_shortcuts_v1')
    expect(DEFAULT_LIMITS.max_global_shortcuts).toBe(MAX_GLOBAL_SHORTCUTS)
    for (const global_shortcuts of [false, true]) {
      const ready = {
        type: 'ready',
        protocol: PROTOCOL_VERSION,
        capabilities: [...REQUIRED_CAPABILITIES, 'global_shortcuts_v1'],
        limits: DEFAULT_LIMITS,
        service_policy: {
          window_display: false,
          clipboard_read: false,
          clipboard_write: false,
          global_shortcuts,
          notifications: false,
        },
      } satisfies NativeEvent
      expect(parseEvent(ready)).toEqual(ready)
      for (const value of [undefined, 'allow', 1])
        expect(() =>
          parseEvent({
            ...ready,
            service_policy: { ...ready.service_policy, global_shortcuts: value },
          })
        ).toThrow()
    }
  })

  test('the closed key set matches the native validator exactly', () => {
    expect(GLOBAL_SHORTCUT_KEYS).toHaveLength(26 + 10 + 12)
    for (const key of GLOBAL_SHORTCUT_KEYS)
      expect(() =>
        parseCommand({
          type: 'register_global_shortcut',
          id: 1,
          window_id: 1,
          shortcut_id: 1,
          key,
          modifiers: { control: true, alt: false, shift: false, platform: false },
        })
      ).not.toThrow()
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
})
