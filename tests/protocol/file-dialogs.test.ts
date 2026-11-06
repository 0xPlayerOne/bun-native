import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LIMITS,
  FILE_DIALOG_MODES,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type NativeEvent,
} from '@bun-native/protocol'
import fixtures from '../fixtures/native-file-dialogs.json'

const POLICY = {
  window_display: false,
  clipboard_read: false,
  clipboard_write: false,
  global_shortcuts: false,
  notifications: false,
  filesystem_roots: [],
  processes: [],
}

describe('shared file dialog wire contract (headless)', () => {
  test('file dialogs are an optional capability with an optional explicit grant', () => {
    expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
    expect(fixtures.capability).toBe('file_dialogs_v1')
    expect(FILE_DIALOG_MODES).toEqual(['open_file', 'open_files', 'open_directory', 'save_file'])
    const ready = {
      type: 'ready',
      protocol: PROTOCOL_VERSION,
      capabilities: [...REQUIRED_CAPABILITIES, 'file_dialogs_v1'],
      limits: DEFAULT_LIMITS,
      service_policy: POLICY,
    } satisfies NativeEvent
    // A policy without the field is a denial and parses unchanged.
    expect(parseEvent(ready)).toEqual(ready)
    for (const file_dialogs of [false, true]) {
      const granted = { ...ready, service_policy: { ...POLICY, file_dialogs } }
      expect(parseEvent(granted)).toEqual(granted)
    }
    for (const value of [null, 'allow', 1])
      expect(() =>
        parseEvent({
          ...ready,
          service_policy: { ...POLICY, file_dialogs: value },
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
