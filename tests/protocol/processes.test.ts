import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LIMITS,
  MAX_PROCESSES,
  parseCommand,
  parseEvent,
  processArgument,
  processesFromArguments,
  PROTOCOL_VERSION,
} from '@bun-native/protocol'
import fixtures from '../fixtures/native-processes.json'

describe('shared owned process wire contract (headless)', () => {
  test('processes are an optional capability bounded by negotiated limits', () => {
    expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
    expect(fixtures.capability).toBe('processes_v1')
    expect(DEFAULT_LIMITS.max_processes).toBe(MAX_PROCESSES)
  })

  test('launch executables round-trip through their reserved native arguments', () => {
    const entries = [
      { id: 'shell', executable: '/bin/sh' },
      { id: 'tool', executable: '/opt/a:b/tool' },
      { id: 'cmd', executable: 'C:\\Windows\\System32\\cmd.exe' },
    ]
    const argv = ['host', '--other', ...entries.map(processArgument)]
    expect(argv.slice(2)).toEqual([
      '--bun-native-process=shell:/bin/sh',
      '--bun-native-process=tool:/opt/a:b/tool',
      '--bun-native-process=cmd:C:\\Windows\\System32\\cmd.exe',
    ])
    expect(processesFromArguments(argv)).toEqual(entries)
    for (const entry of [
      { id: 'shell', executable: 'sh' },
      { id: 'Shell', executable: '/bin/sh' },
      { id: 'shell', executable: '/' },
      { id: 'shell', executable: 'C:\\' },
      { id: 'shell', executable: '/bin/../sh' },
      { id: 'shell', executable: '/bin/sh', extra: true },
    ])
      expect(() => processArgument(entry as never)).toThrow()
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
