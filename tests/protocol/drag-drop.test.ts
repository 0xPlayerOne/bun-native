import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LIMITS,
  MAX_DROP_ITEMS,
  MAX_DROP_NAME_BYTES,
  MAX_DROP_TARGETS,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
} from '@bun-native/protocol'
import fixtures from '../fixtures/native-drag-drop.json'

describe('shared drag-and-drop wire contract (headless)', () => {
  test('drops are an optional capability bounded by negotiated limits', () => {
    expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
    expect(fixtures.capability).toBe('drag_drop_files_v1')
    expect(DEFAULT_LIMITS.max_drop_targets).toBe(MAX_DROP_TARGETS)
    expect(DEFAULT_LIMITS.max_drop_items).toBe(MAX_DROP_ITEMS)
    expect(MAX_DROP_NAME_BYTES).toBe(255)
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
