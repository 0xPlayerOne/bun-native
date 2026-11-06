import { describe, expect, test } from 'bun:test'
import {
  FILE_ACCESS,
  fileResultAnswers,
  MAX_DIRECTORY_ENTRIES,
  MAX_FILE_CHUNK_BYTES,
  MAX_FILE_GRANTS,
  MAX_FILESYSTEM_ROOTS,
  parseEvent,
  parseFilePath,
  parseFilesystemRoots,
  parseRootId,
  type FileOperation,
  type FileResult,
} from '@bun-native/protocol'

const root = (id: string) => ({ id, path: '/srv/' + id, access: 'read' as const })
const result = (value: unknown) => () =>
  parseEvent({ type: 'file_result', id: 1, window_id: 1, grant_id: 1, result: value })

describe('filesystem grant parsers (headless)', () => {
  test('the documented bounds are the exported constants', () => {
    expect([
      MAX_FILESYSTEM_ROOTS,
      MAX_FILE_GRANTS,
      MAX_FILE_CHUNK_BYTES,
      MAX_DIRECTORY_ENTRIES,
    ]).toEqual([8, 32, 16_384, 64])
    expect(FILE_ACCESS).toEqual(['read', 'read_write'])
  })

  test('launch roots are at most eight unique IDs', () => {
    const eight = Array.from({ length: 8 }, (_, index) => root('root' + index))
    expect(parseFilesystemRoots(eight)).toEqual(eight)
    for (const value of [
      [...eight, root('root8')],
      { work: '/srv' },
      undefined,
      [root('a'), root('a')],
    ])
      expect(() => parseFilesystemRoots(value)).toThrow()
  })

  test('root IDs are 1-32 lowercase characters starting with a letter', () => {
    for (const id of ['a', 'work-1', 'my_root', 'a'.repeat(32)]) expect(parseRootId(id)).toBe(id)
    for (const id of ['', 'a'.repeat(33), '1work', '-work', '_work', 'Work', 'wörk', 1])
      expect(() => parseRootId(id)).toThrow()
  })

  test('paths are bounded by bytes, names and components', () => {
    expect(parseFilePath('')).toBe('')
    expect(parseFilePath('a'.repeat(255))).toBe('a'.repeat(255))
    // 1,024 bytes in all, whatever the component count.
    const long = Array.from({ length: 4 }, () => 'a'.repeat(255)).join('/')
    expect(parseFilePath(long)).toBe(long)
    expect(() => parseFilePath(long + '/abcd')).toThrow()
    for (const path of ['é'.repeat(128), 'a\u007f', 'a\u0085b', 'a/./b', 'a/'])
      expect(() => parseFilePath(path)).toThrow()
  })

  test('result flags are booleans and counts are nonnegative integers', () => {
    expect(result({ kind: 'list', entries: [], complete: true, omitted: 0 })).not.toThrow()
    expect(result({ kind: 'list', entries: [], complete: 1, omitted: 0 })).toThrow()
    expect(result({ kind: 'list', entries: [], complete: true, omitted: -1 })).toThrow()
    expect(result({ kind: 'read', data: '', end_of_file: true })).not.toThrow()
    expect(result({ kind: 'read', data: '', end_of_file: 'yes' })).toThrow()
    // Modification times before the epoch are representable.
    expect(result({ kind: 'stat', file_kind: 'other', size: 0, modified_ms: -1 })).not.toThrow()
    expect(result({ kind: 'done', extra: true })).toThrow()
    // Names compare as UTF-8 bytes, not UTF-16 code units.
    const entries = ['｡', '\u{1F600}'].map((name) => ({ name, kind: 'file' }))
    expect(result({ kind: 'list', entries, complete: true, omitted: 0 })).not.toThrow()
    expect(
      result({ kind: 'list', entries: [...entries].reverse(), complete: true, omitted: 0 })
    ).toThrow()
  })

  test('each operation is answered by exactly one result shape', () => {
    const operations: FileOperation[] = [
      { kind: 'stat' },
      { kind: 'list' },
      { kind: 'read', offset: 0, length: 1 },
      { kind: 'write', mode: 'create', data: '' },
      { kind: 'create_directory' },
      { kind: 'remove' },
    ]
    const results: FileResult[] = [
      { kind: 'stat', file_kind: 'file', size: 0, modified_ms: 0 },
      { kind: 'list', entries: [], complete: true, omitted: 0 },
      { kind: 'read', data: '', end_of_file: true },
      { kind: 'written', bytes: 0 },
      { kind: 'done' },
    ]
    expect(
      operations.map((operation) =>
        results.filter((item) => fileResultAnswers(operation, item)).map((item) => item.kind)
      )
    ).toEqual([['stat'], ['list'], ['read'], ['written'], ['done'], ['done']])
  })
})
