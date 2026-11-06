import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LIMITS,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type NativeEvent,
} from '@bun-native/protocol'
import fixtures from '../fixtures/native-message-dialogs.json'

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

describe('shared message dialog wire contract (headless)', () => {
  test('message dialogs are an optional capability with an optional explicit grant', () => {
    expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
    expect(fixtures.capability).toBe('task_dialogs_v1')
    const ready = {
      type: 'ready',
      protocol: PROTOCOL_VERSION,
      capabilities: [...REQUIRED_CAPABILITIES, 'task_dialogs_v1'],
      limits: DEFAULT_LIMITS,
      service_policy: POLICY,
    } satisfies NativeEvent
    // A policy without the field is a denial and parses unchanged.
    expect(parseEvent(ready)).toEqual(ready)
    for (const task_dialogs of [false, true]) {
      const granted = { ...ready, service_policy: { ...POLICY, task_dialogs } }
      expect(parseEvent(granted)).toEqual(granted)
    }
    for (const value of [null, 'allow', 1])
      expect(() =>
        parseEvent({
          ...ready,
          service_policy: { ...POLICY, task_dialogs: value },
        })
      ).toThrow()
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
