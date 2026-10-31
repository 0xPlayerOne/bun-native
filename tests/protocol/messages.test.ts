import { describe, expect, test } from 'bun:test'
import {
  MAX_TEXT_BYTES,
  parseCommand,
  parseEvent,
  ProtocolError,
  type Command,
  type NativeEvent,
} from '@bun-native/protocol'

describe('native message validation', () => {
  test('validates every command shape', () => {
    for (const command of [
      { id: 1, type: 'hello', protocol: 1 },
      { id: 2, type: 'open', title: 'Bun Native', text: 'Hello', input: '' },
      { id: 3, type: 'update', text: 'Updated' },
      { id: 4, type: 'update', input: 'typed' },
      { id: 5, type: 'update', text: '', input: '' },
      { id: 6, type: 'close' },
      { id: 7, type: 'shutdown' },
    ] satisfies Command[])
      expect(parseCommand(command)).toEqual(command)
  })

  test('validates every native event shape', () => {
    for (const event of [
      { type: 'ready', protocol: 1 },
      { type: 'ack', id: 1 },
      { type: 'opened', id: 2 },
      { type: 'click' },
      { type: 'input', value: '世界' },
      { type: 'closed' },
      { type: 'error', id: 3, code: 'invalid_state', message: 'No window' },
      { type: 'error', code: 'invalid_command', message: 'Bad JSON' },
    ] satisfies NativeEvent[])
      expect(parseEvent(event)).toEqual(event)
  })

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null])(
    'rejects invalid request id %s',
    (id) => {
      expect(() => parseCommand({ id, type: 'close' })).toThrow(ProtocolError)
      expect(() => parseEvent({ id, type: 'ack' })).toThrow(ProtocolError)
    }
  )

  test.each(
    [
      null,
      [],
      'hello',
      { id: 1, type: 'unknown' },
      { id: 1, type: 'hello', protocol: 2 },
      { id: 1, type: 'update' },
      { id: 1, type: 'update', text: null },
      { id: 1, type: 'close', unrelated: true },
      { id: 1, type: 'open', title: '', text: '', input: '' },
      { id: 1, type: 'open', title: 'title\n', text: '', input: '' },
      { id: 1, type: 'open', title: 'a'.repeat(257), text: '', input: '' },
      { id: 1, type: 'update', text: '\ud800' },
      { id: 1, type: 'update', text: '😀'.repeat(MAX_TEXT_BYTES / 4 + 1) },
    ].map((value) => ({ value }))
  )('rejects invalid commands %#', ({ value: command }) => {
    expect(() => parseCommand(command)).toThrow(ProtocolError)
  })

  test.each(
    [
      null,
      [],
      { type: 'unknown' },
      { type: 'ready', protocol: 2 },
      { type: 'click', id: 1 },
      { type: 'input', value: 12 },
      { type: 'error', code: 'invalid code', message: 'Bad' },
      { type: 'error', code: 'invalid_command', message: null },
    ].map((value) => ({ value }))
  )('rejects invalid native events %#', ({ value: event }) => {
    expect(() => parseEvent(event)).toThrow(ProtocolError)
  })
})
