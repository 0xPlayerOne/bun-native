import { ProtocolError } from './framing.ts'
import { keys, object, string } from './values.ts'

/** Live file dialogs per session. Each window owns at most one at a time. */
export const MAX_FILE_DIALOGS = 16
export const MAX_DIALOG_TITLE_BYTES = 256
export const MAX_DIALOG_LABEL_BYTES = 64
export const MAX_DIALOG_PATH_BYTES = 4_096
export const MAX_DIALOG_NAME_BYTES = 255
export const MAX_DIALOG_FILTERS = 16
export const MAX_DIALOG_FILTER_PATTERNS = 16
export const MAX_DIALOG_FILTER_NAME_BYTES = 128
export const MAX_DIALOG_PATTERN_BYTES = 64
/** Selected paths in one result. The whole result must also fit one frame. */
export const MAX_DIALOG_PATHS = 256

export const FILE_DIALOG_MODES = Object.freeze([
  'open_file',
  'open_files',
  'open_directory',
  'save_file',
] as const)
export type FileDialogMode = (typeof FILE_DIALOG_MODES)[number]

export interface FileFilter {
  name: string
  patterns: readonly string[]
}

export interface FileDialogOptions {
  mode: FileDialogMode
  title: string
  accept_label?: string
  folder?: string
  name?: string
  filters?: readonly FileFilter[]
}

/** Paths are data: a selection carries no filesystem authority. */
export type FileDialogResult =
  | { kind: 'selected'; paths: readonly string[] }
  | { kind: 'cancelled' }
  | { kind: 'failed'; code: 'native_failure' | 'payload_too_large' }

function line(value: unknown, field: string, limit: number): string {
  const text = string(value, field, limit)
  if (!text || /\p{Cc}/u.test(text))
    throw new ProtocolError(field + ' must be nonempty and contain no control characters')
  return text
}

/** A nonempty absolute POSIX path without NUL, at most 4096 UTF-8 bytes. */
function parseDialogPath(value: unknown, field = 'dialog path'): string {
  const path = string(value, field, MAX_DIALOG_PATH_BYTES)
  if (!path.startsWith('/')) throw new ProtocolError(field + ' must be absolute')
  return path
}

function filter(value: unknown): FileFilter {
  const data = object(value)
  keys(data, ['name', 'patterns'])
  const patterns = data['patterns']
  if (
    !Array.isArray(patterns) ||
    patterns.length < 1 ||
    patterns.length > MAX_DIALOG_FILTER_PATTERNS
  )
    throw new ProtocolError('A file filter needs between 1 and 16 patterns')
  return {
    name: line(data['name'], 'file filter name', MAX_DIALOG_FILTER_NAME_BYTES),
    patterns: patterns.map((pattern) =>
      line(pattern, 'file filter pattern', MAX_DIALOG_PATTERN_BYTES)
    ),
  }
}

export function parseFileDialogOptions(value: unknown): FileDialogOptions {
  const data = object(value)
  keys(data, ['mode', 'title', 'accept_label', 'folder', 'name', 'filters'])
  const mode = FILE_DIALOG_MODES.find((candidate) => candidate === data['mode'])
  if (!mode) throw new ProtocolError('Unknown file dialog mode')
  const options: FileDialogOptions = {
    mode,
    title: line(data['title'], 'dialog title', MAX_DIALOG_TITLE_BYTES),
  }
  if ('accept_label' in data)
    options.accept_label = line(data['accept_label'], 'dialog accept label', MAX_DIALOG_LABEL_BYTES)
  if ('folder' in data) options.folder = parseDialogPath(data['folder'], 'dialog folder')
  if ('name' in data) {
    if (mode !== 'save_file') throw new ProtocolError('Only a save dialog accepts a suggested name')
    const name = line(data['name'], 'suggested name', MAX_DIALOG_NAME_BYTES)
    if (name.includes('/') || name === '.' || name === '..')
      throw new ProtocolError('Suggested name must be one path component')
    options.name = name
  }
  if ('filters' in data) {
    const filters = data['filters']
    if (!Array.isArray(filters) || filters.length > MAX_DIALOG_FILTERS)
      throw new ProtocolError('A file dialog accepts at most 16 filters')
    if (filters.length && mode === 'open_directory')
      throw new ProtocolError('A folder dialog does not accept file filters')
    if (filters.length) options.filters = filters.map(filter)
  }
  return options
}

export function parseFileDialogResult(value: unknown): FileDialogResult {
  const data = object(value)
  switch (data['kind']) {
    case 'selected': {
      keys(data, ['kind', 'paths'])
      const paths = data['paths']
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_DIALOG_PATHS)
        throw new ProtocolError('A dialog selection holds between 1 and 256 paths')
      return { kind: 'selected', paths: paths.map((path) => parseDialogPath(path)) }
    }
    case 'cancelled':
      keys(data, ['kind'])
      return { kind: 'cancelled' }
    case 'failed': {
      keys(data, ['kind', 'code'])
      const code = (['native_failure', 'payload_too_large'] as const).find(
        (candidate) => candidate === data['code']
      )
      if (!code) throw new ProtocolError('Unknown file dialog failure')
      return { kind: 'failed', code }
    }
    default:
      throw new ProtocolError('Unknown file dialog result')
  }
}
