import { describe, expect, test } from 'bun:test'
import {
  MAX_PROCESS_EXECUTABLES,
  MAX_PROCESS_OUTPUT_CREDIT,
  parseCommand,
  parseEvent,
  parseProcessExecutables,
  parseProcessLaunch,
  PROCESS_SIGNALS,
  processesFromArguments,
} from '@bun-native/protocol'

const entry = (id: string) => ({ id, executable: '/usr/bin/' + id })

describe('owned process parsers (headless)', () => {
  test('the documented bounds are the exported constants', () => {
    expect([MAX_PROCESS_EXECUTABLES, MAX_PROCESS_OUTPUT_CREDIT]).toEqual([8, 4])
    expect(PROCESS_SIGNALS).toEqual(['interrupt', 'terminate', 'kill', 'hangup'])
    expect(Object.isFrozen(PROCESS_SIGNALS)).toBe(true)
  })

  test('launch executables are at most eight unique IDs', () => {
    const eight = Array.from({ length: 8 }, (_, index) => entry('tool' + index))
    expect(parseProcessExecutables(eight)).toEqual(eight)
    expect(parseProcessExecutables([])).toEqual([])
    for (const value of [
      [...eight, entry('tool8')],
      [entry('tool'), entry('tool')],
      { tool: '/bin/tool' },
      undefined,
      // IDs are 1-32 characters starting with a letter.
      [entry('a'.repeat(33))],
      [entry('1tool')],
      [{ id: 'tool', executable: '/bin/tool\nx' }],
    ])
      expect(() => parseProcessExecutables(value)).toThrow()
    expect(parseProcessExecutables([entry('a'.repeat(32))])).toHaveLength(1)
  })

  test('only reserved process arguments are recovered, in order', () => {
    expect(
      processesFromArguments([
        'host',
        '--bun-native-filesystem-root=read:work:/srv',
        '--bun-native-process=git:/usr/bin/git',
        '--bun-native-process=sh:/bin/sh',
      ])
    ).toEqual([
      { id: 'git', executable: '/usr/bin/git' },
      { id: 'sh', executable: '/bin/sh' },
    ])
    expect(processesFromArguments(['host'])).toEqual([])
    expect(() =>
      processesFromArguments(['--bun-native-process=sh:/bin/sh', '--bun-native-process=sh:/bin/sh'])
    ).toThrow()
  })

  test('arguments and environment are bounded in UTF-8 bytes, together and apart', () => {
    const launch =
      (args: string[], env: Record<string, string> = {}) =>
      () =>
        parseProcessLaunch({ executable: 'shell', args, env })
    // 4,096 bytes per argument, counted after encoding.
    expect(launch(['a'.repeat(4_096)])).not.toThrow()
    expect(launch(['é'.repeat(2_049)])).toThrow()
    expect(launch(['\uD800'])).toThrow()
    // 32,768 bytes of arguments, names and values in all.
    expect(launch(Array.from({ length: 8 }, () => 'a'.repeat(4_096)))).not.toThrow()
    expect(
      launch(
        Array.from({ length: 8 }, () => 'a'.repeat(4_096)),
        { A: '' }
      )
    ).toThrow()
    // Names are identifiers of at most 128 bytes; values at most 4,096 bytes.
    expect(launch([], { ['_'.repeat(128)]: '' })).not.toThrow()
    expect(launch([], { ['_'.repeat(129)]: '' })).toThrow()
    expect(launch([], { A: 'a'.repeat(4_096) })).not.toThrow()
    expect(launch([], { A: 'a'.repeat(4_097) })).toThrow()
    expect(launch([], { 'A-B': '' })).toThrow()
  })

  test('terminal sizes are 1 to 1,000 in each dimension', () => {
    const spawn = (terminal: unknown) => () =>
      parseProcessLaunch({ executable: 'shell', args: [], env: {}, terminal })
    expect(spawn({ columns: 1_000, rows: 1 })).not.toThrow()
    for (const terminal of [
      { columns: 1_001, rows: 1 },
      { columns: 1, rows: 0 },
      { columns: 1.5, rows: 1 },
      { columns: 1 },
      { columns: 1, rows: 1, pixels: 1 },
    ])
      expect(spawn(terminal)).toThrow()
  })

  test('exit statuses carry exactly one code (0-255) or signal (1-64)', () => {
    const exited = (exit: unknown) => () =>
      parseEvent({ type: 'process_exited', sequence: 1, window_id: 1, process_id: 1, exit })
    for (const exit of [{ code: 0 }, { code: 255 }, { signal: 1 }, { signal: 64 }])
      expect(exited(exit)).not.toThrow()
    for (const exit of [
      { code: 256 },
      { code: -1 },
      { signal: 0 },
      { signal: 65 },
      { code: 0, signal: 9 },
      {},
    ])
      expect(exited(exit)).toThrow()
  })

  test('acknowledgements and signals carry only their own fields', () => {
    const command = (value: Record<string, unknown>) => () =>
      parseCommand({ id: 1, window_id: 1, process_id: 1, ...value })
    expect(command({ type: 'acknowledge_process_output', chunk: 1 })).not.toThrow()
    expect(command({ type: 'acknowledge_process_output', chunk: 1, extra: 1 })).toThrow()
    expect(command({ type: 'signal_process', signal: 'hangup' })).not.toThrow()
    expect(command({ type: 'signal_process', signal: 'HUP' })).toThrow()
    expect(command({ type: 'close_process_input', data: 'AA==' })).toThrow()
  })
})
