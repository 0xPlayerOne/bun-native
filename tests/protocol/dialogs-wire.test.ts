import { describe, expect, test } from 'bun:test'
import {
  MAX_DIALOG_FILTER_NAME_BYTES,
  MAX_DIALOG_FILTER_PATTERNS,
  MAX_DIALOG_FILTERS,
  MAX_DIALOG_LABEL_BYTES,
  MAX_DIALOG_NAME_BYTES,
  MAX_DIALOG_PATH_BYTES,
  MAX_DIALOG_PATHS,
  MAX_DIALOG_PATTERN_BYTES,
  MAX_DIALOG_TITLE_BYTES,
  MAX_FILE_DIALOGS,
  parseEvent,
  parseFileDialogOptions,
  ProtocolError,
} from '@bun-native/protocol'

const completed = (result: unknown) => ({
  type: 'file_dialog_completed',
  sequence: 1,
  window_id: 1,
  dialog_id: 1,
  result,
})

describe('file dialog wire bounds (headless)', () => {
  test('exported bounds match the documented limits', () => {
    expect({
      MAX_FILE_DIALOGS,
      MAX_DIALOG_TITLE_BYTES,
      MAX_DIALOG_LABEL_BYTES,
      MAX_DIALOG_PATH_BYTES,
      MAX_DIALOG_NAME_BYTES,
      MAX_DIALOG_FILTERS,
      MAX_DIALOG_FILTER_PATTERNS,
      MAX_DIALOG_FILTER_NAME_BYTES,
      MAX_DIALOG_PATTERN_BYTES,
      MAX_DIALOG_PATHS,
    }).toEqual({
      MAX_FILE_DIALOGS: 16,
      MAX_DIALOG_TITLE_BYTES: 256,
      MAX_DIALOG_LABEL_BYTES: 64,
      MAX_DIALOG_PATH_BYTES: 4_096,
      MAX_DIALOG_NAME_BYTES: 255,
      MAX_DIALOG_FILTERS: 16,
      MAX_DIALOG_FILTER_PATTERNS: 16,
      MAX_DIALOG_FILTER_NAME_BYTES: 128,
      MAX_DIALOG_PATTERN_BYTES: 64,
      MAX_DIALOG_PATHS: 256,
    })
  })

  test('options keep only present fields; an empty filter list is dropped', () => {
    expect(parseFileDialogOptions({ mode: 'open_file', title: 'Open', filters: [] })).toEqual({
      mode: 'open_file',
      title: 'Open',
    })
    // An empty list is allowed even where filters are not.
    expect(
      parseFileDialogOptions({ mode: 'open_directory', title: 'Folder', filters: [] })
    ).toEqual({ mode: 'open_directory', title: 'Folder' })
    expect(parseFileDialogOptions({ mode: 'save_file', title: 'Save', folder: '/' })).toEqual({
      mode: 'save_file',
      title: 'Save',
      folder: '/',
    })
  })

  test('folders are absolute POSIX paths; Windows forms are rejected', () => {
    for (const folder of ['C:\\Users', 'C:/Users', '\\\\server\\share', '~/docs', 'file:///tmp'])
      expect(() => parseFileDialogOptions({ mode: 'open_file', title: 'Open', folder })).toThrow(
        ProtocolError
      )
  })

  test('each mode yields its own result shape', () => {
    const paths = Array.from({ length: MAX_DIALOG_PATHS }, (_, index) => `/p/${index}`)
    expect(parseEvent(completed({ kind: 'selected', paths }))).toMatchObject({
      result: { kind: 'selected', paths },
    })
    expect(parseEvent(completed({ kind: 'cancelled' }))).toMatchObject({
      result: { kind: 'cancelled' },
    })
    for (const code of ['native_failure', 'payload_too_large'])
      expect(parseEvent(completed({ kind: 'failed', code }))).toMatchObject({
        result: { kind: 'failed', code },
      })
  })

  test('malformed results are protocol errors', () => {
    for (const result of [
      null,
      'cancelled',
      {},
      { kind: 'selected' },
      { kind: 'selected', paths: '/a' },
      { kind: 'selected', paths: ['C:\\a'] },
      { kind: 'selected', paths: ['/a'], path: '/a' },
      { kind: 'failed' },
      { kind: 'failed', code: 'cancelled' },
      { kind: 'failed', code: 'permission_denied' },
      { kind: 'failed', code: 'native_failure', message: 'x' },
      { kind: 'cancelled', reason: 'escape' },
    ])
      expect(() => parseEvent(completed(result))).toThrow(ProtocolError)
  })
})
