import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LIMITS,
  MAX_NOTIFICATIONS,
  NOTIFICATION_DISMISSALS,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type NativeEvent,
} from '@bun-native/protocol'
import fixtures from '../fixtures/native-notifications.json'

describe('shared notification wire contract (headless)', () => {
  test('notifications are an optional capability with an explicit grant', () => {
    expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
    expect(fixtures.capability).toBe('notifications_v1')
    expect(DEFAULT_LIMITS.max_notifications).toBe(MAX_NOTIFICATIONS)
    expect(NOTIFICATION_DISMISSALS).toEqual(['expired', 'dismissed', 'closed'])
    for (const notifications of [false, true]) {
      const ready = {
        type: 'ready',
        protocol: PROTOCOL_VERSION,
        capabilities: [...REQUIRED_CAPABILITIES, 'notifications_v1'],
        limits: DEFAULT_LIMITS,
        service_policy: {
          window_display: false,
          clipboard_read: false,
          clipboard_write: false,
          global_shortcuts: false,
          notifications,
          drag_drop: false,
          filesystem_roots: [],
          processes: [],
        },
      } satisfies NativeEvent
      expect(parseEvent(ready)).toEqual(ready)
      for (const value of [undefined, 'allow', 1])
        expect(() =>
          parseEvent({
            ...ready,
            service_policy: { ...ready.service_policy, notifications: value },
          })
        ).toThrow()
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
})
