import { describe, expect, test } from 'bun:test'
import {
  DRAG_STATES,
  DROP_REJECTIONS,
  MAX_DROP_ITEMS,
  MAX_DROP_NAME_BYTES,
  MAX_DROP_TARGETS,
  parseCommand,
  parseEvent,
  ProtocolError,
} from '@bun-native/protocol'

const drop = (items: unknown, drop_id: unknown = 1) => ({
  type: 'drop_received',
  sequence: 1,
  window_id: 1,
  target_id: 1,
  drop_id,
  items,
})
const resolved = (path: unknown) => ({
  type: 'dropped_item_resolved',
  id: 3,
  window_id: 1,
  target_id: 1,
  drop_id: 1,
  item: 0,
  root: 'work',
  path,
})
const named = (count: number) => Array.from({ length: count }, () => ({ name: 'a' }))

describe('drag-and-drop wire bounds (headless)', () => {
  test('bounds and closed vocabularies', () => {
    expect([MAX_DROP_TARGETS, MAX_DROP_ITEMS, MAX_DROP_NAME_BYTES]).toEqual([32, 64, 255])
    expect(DRAG_STATES).toEqual(['entered', 'left'])
    expect(DROP_REJECTIONS).toEqual(['empty', 'limit_exceeded'])
    expect(Object.isFrozen(DRAG_STATES) && Object.isFrozen(DROP_REJECTIONS)).toBe(true)
  })

  test('a drop holds 1 to 64 items; a larger one is rejected, never truncated', () => {
    for (const count of [1, MAX_DROP_ITEMS])
      expect(parseEvent(drop(named(count)))).toMatchObject({ items: named(count) })
    for (const items of [[], named(MAX_DROP_ITEMS + 1), null, { name: 'a' }, 'a'])
      expect(() => parseEvent(drop(items))).toThrow(ProtocolError)
  })

  test('display names are bounded single lines; they are not checked as paths', () => {
    const atLimit = 'é'.repeat(127) + 'a' // 255 bytes
    for (const name of [atLimit, '../etc', '/abs/path', 'C:\\x', 'a/b', '.'])
      expect(parseEvent(drop([{ name }]))).toMatchObject({ items: [{ name }] })
    for (const name of [
      atLimit + 'a',
      'é'.repeat(128),
      '',
      'a\u007fb',
      'a\u0085b',
      'a\rb',
      'a\0b',
      '\ud800',
      1,
    ])
      expect(() => parseEvent(drop([{ name }]))).toThrow(ProtocolError)
  })

  test('drop and item identities are positive and bounded', () => {
    for (const drop_id of [0, -1, 1.5, '1'])
      expect(() => parseEvent(drop(named(1), drop_id))).toThrow()
    const command = (item: unknown) => ({
      type: 'resolve_dropped_item',
      id: 5,
      window_id: 1,
      target_id: 1,
      drop_id: 1,
      item,
      root: 'work',
    })
    expect(parseCommand(command(MAX_DROP_ITEMS - 1))).toMatchObject({ item: 63 })
    for (const item of [MAX_DROP_ITEMS, -1, 0.5, '0', null])
      expect(() => parseCommand(command(item))).toThrow()
  })

  test('a resolved path is empty or relative, slash-separated and never traverses', () => {
    for (const path of ['', 'a.txt', 'nested/dir/a.txt', 'b c/ü.txt'])
      expect(parseEvent(resolved(path))).toMatchObject({ path })
    for (const path of [
      '/etc/passwd',
      '//server/share',
      '..',
      '../a',
      'a/../../b',
      'a/./b',
      'a//b',
      'a/',
      'a\nb',
      Array(33).fill('a').join('/'),
    ])
      expect(() => parseEvent(resolved(path))).toThrow(ProtocolError)
  })

  test('Windows-style separators are not separators: they stay inside one name', () => {
    // The host builds resolved paths from `Component::Normal` names joined by
    // `/`, so a Windows drive or backslash never appears there. The parser
    // treats `\` and `:` as ordinary name bytes, as POSIX file names allow:
    // they cannot traverse because the grant layer splits only on `/`.
    for (const path of ['C:', 'C:\\Windows\\x', '..\\secret', 'a\\..\\b'])
      expect(parseEvent(resolved(path))).toMatchObject({ path })
    expect(() => parseEvent(resolved('C:/..'))).toThrow(ProtocolError)
  })
})
