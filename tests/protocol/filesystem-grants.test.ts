import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LIMITS,
  filesystemRootArgument,
  filesystemRootsFromArguments,
  MAX_FILE_CHUNK_BYTES,
  MAX_FILE_GRANTS,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
} from '@bun-native/protocol'
import fixtures from '../fixtures/native-filesystem-grants.json'
import launchPaths from '../fixtures/native-launch-paths.json'

describe('shared filesystem grant wire contract (headless)', () => {
  test('grants are an optional capability bounded by negotiated limits', () => {
    expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
    expect(fixtures.capability).toBe('filesystem_grants_v1')
    expect(DEFAULT_LIMITS.max_file_grants).toBe(MAX_FILE_GRANTS)
    expect(DEFAULT_LIMITS.max_file_chunk_bytes).toBe(MAX_FILE_CHUNK_BYTES)
  })

  test('launch roots round-trip through their reserved native arguments', () => {
    const roots = [
      { id: 'work', path: '/tmp/a:b', access: 'read_write' },
      { id: 'docs', path: '/', access: 'read' },
    ] as const
    const argv = ['host', '--other', ...roots.map(filesystemRootArgument)]
    expect(argv.slice(2)).toEqual([
      '--bun-native-filesystem-root=read_write:work:/tmp/a:b',
      '--bun-native-filesystem-root=read:docs:/',
    ])
    expect(filesystemRootsFromArguments(argv)).toEqual([...roots])
    for (const root of [
      { id: 'work', path: 'relative', access: 'read' },
      { id: 'Work', path: '/a', access: 'read' },
      { id: 'work', path: '/a/', access: 'read' },
      { id: 'work', path: '/a', access: 'write' },
      { id: 'work', path: '/a', access: 'read', extra: true },
    ])
      expect(() => filesystemRootArgument(root as never)).toThrow()
  })

  test('launch paths are POSIX or Windows drive paths, shared with Rust', () => {
    for (const path of [...launchPaths.posix, ...launchPaths.windows]) {
      const root = { id: 'root', path, access: 'read' } as const
      expect(filesystemRootsFromArguments(['host', filesystemRootArgument(root)])).toEqual([root])
    }
    for (const path of launchPaths.invalid)
      expect(() => filesystemRootArgument({ id: 'root', path, access: 'read' })).toThrow()
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
