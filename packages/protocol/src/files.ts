import { ProtocolError } from './framing.ts'
import { integer, keys, object, string } from './values.ts'

export const MAX_FILESYSTEM_ROOTS = 8
export const MAX_FILE_GRANTS = 32
const MAX_FILE_PATH_BYTES = 1_024
const MAX_FILE_PATH_COMPONENTS = 32
const MAX_FILE_NAME_BYTES = 255
const MAX_ROOT_PATH_BYTES = 4_096
export const MAX_FILE_CHUNK_BYTES = 16_384
export const MAX_DIRECTORY_ENTRIES = 64
const MAX_FILE_CHUNK_BASE64 = Math.ceil(MAX_FILE_CHUNK_BYTES / 3) * 4
const FILESYSTEM_ROOT_ARGUMENT = '--bun-native-filesystem-root='
const encoder = new TextEncoder()

export const FILE_ACCESS = Object.freeze(['read', 'read_write'] as const)
export type FileAccess = (typeof FILE_ACCESS)[number]

export interface FilesystemRoot {
  id: string
  path: string
  access: FileAccess
}

export type WriteMode = 'create' | 'truncate' | 'append'
export type FileKind = 'file' | 'directory' | 'symlink' | 'other'

export type FileOperation =
  | { kind: 'stat' }
  | { kind: 'list'; after?: string }
  | { kind: 'read'; offset: number; length: number }
  | { kind: 'write'; mode: WriteMode; data: string }
  | { kind: 'create_directory' }
  | { kind: 'remove' }

export interface DirectoryEntry {
  name: string
  kind: FileKind
}

export type FileResult =
  | { kind: 'stat'; file_kind: FileKind; size: number; modified_ms: number }
  | { kind: 'list'; entries: DirectoryEntry[]; complete: boolean; omitted: number }
  | { kind: 'read'; data: string; end_of_file: boolean }
  | { kind: 'written'; bytes: number }
  | { kind: 'done' }

export function parseRootId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value))
    throw new ProtocolError(
      'Filesystem root ID must be 1-32 lowercase ASCII letters, digits, "-" or "_", starting with a letter'
    )
  return value
}

function parseRootPath(value: unknown): string {
  const path = string(value, 'filesystem root path', MAX_ROOT_PATH_BYTES)
  if (
    !path.startsWith('/') ||
    /\p{Cc}/u.test(path) ||
    (path !== '/' &&
      path
        .slice(1)
        .split('/')
        .some((name) => !name || name === '.' || name === '..'))
  )
    throw new ProtocolError(
      'Filesystem root path must be absolute and normalized, without control characters'
    )
  return path
}

export function parseFileAccess(value: unknown): FileAccess {
  if (!FILE_ACCESS.includes(value as FileAccess))
    throw new ProtocolError('File access must be "read" or "read_write"')
  return value as FileAccess
}

function root(value: unknown): FilesystemRoot {
  const data = object(value)
  keys(data, ['id', 'path', 'access'])
  return {
    id: parseRootId(data['id']),
    path: parseRootPath(data['path']),
    access: parseFileAccess(data['access']),
  }
}

export function parseFilesystemRoots(value: unknown): FilesystemRoot[] {
  if (!Array.isArray(value) || value.length > MAX_FILESYSTEM_ROOTS)
    throw new ProtocolError('At most ' + MAX_FILESYSTEM_ROOTS + ' filesystem roots may be granted')
  const roots = value.map(root)
  if (new Set(roots.map((item) => item.id)).size !== roots.length)
    throw new ProtocolError('Filesystem root IDs must be unique')
  return roots
}

/** The reserved native launch argument for one validated root. */
export function filesystemRootArgument(value: FilesystemRoot): string {
  const item = root(value)
  return FILESYSTEM_ROOT_ARGUMENT + item.access + ':' + item.id + ':' + item.path
}

/** Recover the launch roots from native arguments, in order. */
export function filesystemRootsFromArguments(argv: readonly string[]): FilesystemRoot[] {
  return parseFilesystemRoots(
    argv
      .filter((argument) => argument.startsWith(FILESYSTEM_ROOT_ARGUMENT))
      .map((argument) => {
        const [access, id, ...path] = argument.slice(FILESYSTEM_ROOT_ARGUMENT.length).split(':')
        return { access, id, path: path.join(':') }
      })
  )
}

function parseFileName(value: unknown): string {
  const name = string(value, 'file name', MAX_FILE_NAME_BYTES)
  if (!name || name === '.' || name === '..' || name.includes('/') || /\p{Cc}/u.test(name))
    throw new ProtocolError(
      'File name must be 1-255 bytes, not "." or "..", without "/" or control characters'
    )
  return name
}

/** Empty (the grant root) or relative names joined by `/`. */
export function parseFilePath(value: unknown): string {
  const path = string(value, 'file path', MAX_FILE_PATH_BYTES)
  if (!path) return path
  const names = path.split('/')
  if (names.length > MAX_FILE_PATH_COMPONENTS)
    throw new ProtocolError('File path exceeds ' + MAX_FILE_PATH_COMPONENTS + ' components')
  for (const name of names) parseFileName(name)
  return path
}

function parseChunk(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_FILE_CHUNK_BASE64 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) ||
    (value.length / 4) * 3 - (value.match(/=*$/)?.[0].length ?? 0) > MAX_FILE_CHUNK_BYTES
  )
    throw new ProtocolError('File data must be padded standard base64 of at most 16384 bytes')
  return value
}

const WRITE_MODES: readonly WriteMode[] = ['create', 'truncate', 'append']
const FILE_KINDS: readonly FileKind[] = ['file', 'directory', 'symlink', 'other']

export function parseFileOperation(value: unknown, path: string): FileOperation {
  const data = object(value)
  const writes = ['write', 'create_directory', 'remove'].includes(data['kind'] as string)
  if (writes && !path)
    throw new ProtocolError('The grant root itself cannot be written, created or removed')
  switch (data['kind']) {
    case 'stat':
    case 'create_directory':
    case 'remove':
      keys(data, ['kind'])
      return { kind: data['kind'] }
    case 'list':
      keys(data, ['kind', 'after'])
      return 'after' in data
        ? { kind: 'list', after: parseFileName(data['after']) }
        : { kind: 'list' }
    case 'read':
      keys(data, ['kind', 'offset', 'length'])
      return {
        kind: 'read',
        offset: integer(
          data['offset'],
          'file read offset',
          0,
          Number.MAX_SAFE_INTEGER - MAX_FILE_CHUNK_BYTES
        ),
        length: integer(data['length'], 'file read length', 1, MAX_FILE_CHUNK_BYTES),
      }
    case 'write': {
      keys(data, ['kind', 'mode', 'data'])
      const mode = WRITE_MODES.find((item) => item === data['mode'])
      if (!mode) throw new ProtocolError('Unknown file write mode')
      return { kind: 'write', mode, data: parseChunk(data['data']) }
    }
    default:
      throw new ProtocolError('Unknown file operation')
  }
}

function fileKind(value: unknown): FileKind {
  const kind = FILE_KINDS.find((item) => item === value)
  if (!kind) throw new ProtocolError('Unknown file kind')
  return kind
}

function compareBytes(left: string, right: string): number {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++)
    if (a[index] !== b[index]) return a[index]! - b[index]!
  return a.length - b.length
}

export function parseFileResult(value: unknown): FileResult {
  const data = object(value)
  switch (data['kind']) {
    case 'stat':
      keys(data, ['kind', 'file_kind', 'size', 'modified_ms'])
      return {
        kind: 'stat',
        file_kind: fileKind(data['file_kind']),
        size: integer(data['size'], 'file size'),
        modified_ms: integer(
          data['modified_ms'],
          'file modification time',
          -Number.MAX_SAFE_INTEGER
        ),
      }
    case 'list': {
      keys(data, ['kind', 'entries', 'complete', 'omitted'])
      const entries = data['entries']
      if (!Array.isArray(entries) || entries.length > MAX_DIRECTORY_ENTRIES)
        throw new ProtocolError('Directory page exceeds ' + MAX_DIRECTORY_ENTRIES + ' entries')
      const parsed = entries.map((entry) => {
        const item = object(entry)
        keys(item, ['name', 'kind'])
        return { name: parseFileName(item['name']), kind: fileKind(item['kind']) }
      })
      for (let index = 1; index < parsed.length; index++)
        if (compareBytes(parsed[index - 1]!.name, parsed[index]!.name) >= 0)
          throw new ProtocolError('Directory entries must be unique and sorted by name')
      if (typeof data['complete'] !== 'boolean')
        throw new ProtocolError('Directory completeness must be a boolean')
      return {
        kind: 'list',
        entries: parsed,
        complete: data['complete'],
        omitted: integer(data['omitted'], 'omitted directory entries'),
      }
    }
    case 'read':
      keys(data, ['kind', 'data', 'end_of_file'])
      if (typeof data['end_of_file'] !== 'boolean')
        throw new ProtocolError('File end-of-file flag must be a boolean')
      return { kind: 'read', data: parseChunk(data['data']), end_of_file: data['end_of_file'] }
    case 'written':
      keys(data, ['kind', 'bytes'])
      return {
        kind: 'written',
        bytes: integer(data['bytes'], 'written bytes', 0, MAX_FILE_CHUNK_BYTES),
      }
    case 'done':
      keys(data, ['kind'])
      return { kind: 'done' }
    default:
      throw new ProtocolError('Unknown file result')
  }
}

/** The result shape each operation produces. */
export function fileResultAnswers(operation: FileOperation, result: FileResult): boolean {
  const expected = {
    stat: 'stat',
    list: 'list',
    read: 'read',
    write: 'written',
    create_directory: 'done',
    remove: 'done',
  }[operation.kind]
  return result.kind === expected
}
