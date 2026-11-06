import { describe, expect, test } from 'bun:test'
import {
  APP_MENU_KEYS,
  DEFAULT_LIMITS,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type NativeEvent,
} from '@bun-native/protocol'
import fixtures from '../fixtures/native-app-menu.json'

const POLICY = {
  window_display: false,
  clipboard_read: false,
  clipboard_write: false,
  global_shortcuts: false,
  notifications: false,
  drag_drop: false,
  filesystem_roots: [],
  processes: [],
}

describe('shared application menu wire contract (headless)', () => {
  test('the menu bar is an optional capability with an optional explicit grant', () => {
    expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
    expect(fixtures.capability).toBe('app_menu_v1')
    expect(APP_MENU_KEYS).toHaveLength(26 + 10 + 12 + 11 + 14)
    const ready = {
      type: 'ready',
      protocol: PROTOCOL_VERSION,
      capabilities: [...REQUIRED_CAPABILITIES, 'app_menu_v1'],
      limits: DEFAULT_LIMITS,
      service_policy: POLICY,
    } satisfies NativeEvent
    expect(parseEvent(ready)).toEqual(ready)
    for (const app_menu of [false, true]) {
      const granted = { ...ready, service_policy: { ...POLICY, app_menu } }
      expect(parseEvent(granted)).toEqual(granted)
    }
    for (const value of [null, 'allow', 1])
      expect(() =>
        parseEvent({
          ...ready,
          service_policy: { ...POLICY, app_menu: value },
        })
      ).toThrow()
  })

  test('a parsed menu bar round-trips exactly', () => {
    const wire = JSON.parse(fixtures.commands[0]!.wire)
    expect(parseCommand(wire)).toEqual(wire)
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
