import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LIMITS,
  MAX_PROCESSES,
  parseCommand,
  parseEvent,
  parseProcessLimitsArgument,
  processArguments,
  processLimitsArgument,
  processesFromArguments,
  PROTOCOL_VERSION,
} from '@bun-native/protocol'
import fixtures from '../fixtures/native-processes.json'
import limitFixtures from '../fixtures/native-process-limits.json'

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
    const argv = ['host', '--other', ...entries.flatMap(processArguments)]
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
      expect(() => processArguments(entry as never)).toThrow()
  })

  test('per-executable limits ride their own reserved argument after the executable', () => {
    const entries = [
      { id: 'shell', executable: '/bin/sh', limits: { cpu_seconds: 2, open_files: 16 } },
      { id: 'tool', executable: '/opt/tool' },
    ]
    const argv = entries.flatMap(processArguments)
    expect(argv).toEqual([
      '--bun-native-process=shell:/bin/sh',
      '--bun-native-process-limits=shell:cpu_seconds=2,open_files=16',
      '--bun-native-process=tool:/opt/tool',
    ])
    expect(processesFromArguments(argv)).toEqual(entries)
    // Limits name a granted executable, once.
    for (const extra of [
      '--bun-native-process-limits=other:cpu_seconds=1',
      '--bun-native-process-limits=shell:cpu_seconds=1',
      '--bun-native-process-limits=cpu_seconds=1',
    ])
      expect(() => processesFromArguments([...argv, extra])).toThrow()
    for (const limits of [{}, { cpu_seconds: 0 }, { threads: 1 }, { memory_bytes: 1.5 }])
      expect(() =>
        processArguments({ id: 'shell', executable: '/bin/sh', limits } as never)
      ).toThrow()
  })

  for (const item of limitFixtures.arguments)
    test(`limit argument: ${item.name}`, () => {
      if (item.limits === null) expect(() => parseProcessLimitsArgument(item.argument)).toThrow()
      else {
        expect(parseProcessLimitsArgument(item.argument)).toEqual(item.limits)
        expect(processLimitsArgument(item.limits)).toBe(item.argument)
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
