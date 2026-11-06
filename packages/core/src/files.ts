import {
  FILE_ACCESS,
  MAX_FILE_CHUNK_BYTES,
  parseFilePath,
  parseRootId,
  type FileAccess,
  type FileKind,
  type FileOperation,
  type FileResult,
  type WriteMode,
} from '@bun-native/protocol'

export interface FileGrantOptions {
  /** At most the root's launch access. Defaults to `read`. */
  readonly access?: FileAccess
}

export interface NativeFileStat {
  readonly kind: FileKind
  readonly size: number
  /** Milliseconds since the Unix epoch. */
  readonly modifiedMs: number
}

export interface NativeDirectoryPage {
  /** At most 64 entries, sorted by UTF-8 name bytes. */
  readonly entries: readonly Readonly<{ name: string; kind: FileKind }>[]
  /** False when more entries follow; pass the last name as `after`. */
  readonly complete: boolean
  /** Names in the directory that are not valid UTF-8 or contain control characters. */
  readonly omitted: number
}

export interface NativeFileChunk {
  readonly bytes: Uint8Array
  readonly endOfFile: boolean
}

/**
 * Scoped authority over one launch root. Paths are relative names joined by
 * `/`; symbolic links are never followed and `..` is rejected. Closing the
 * grant, its window or the application revokes it; later results are withheld.
 */
export interface NativeFileGrant {
  readonly root: string
  readonly access: FileAccess
  /** False once closed or revoked. */
  readonly active: boolean
  stat(path: string): Promise<NativeFileStat>
  list(path?: string, options?: { readonly after?: string }): Promise<NativeDirectoryPage>
  read(
    path: string,
    options?: { readonly offset?: number; readonly length?: number }
  ): Promise<NativeFileChunk>
  /** Writes one chunk of at most 16384 bytes; resolves with the bytes written. */
  write(path: string, bytes: Uint8Array, options?: { readonly mode?: WriteMode }): Promise<number>
  createDirectory(path: string): Promise<void>
  /** Removes a file, an empty directory or a link entry (never its target). */
  remove(path: string): Promise<void>
  /** Idempotent. Revokes locally first, then closes the native descriptor. */
  close(): Promise<void>
}

export function fileGrantRequest(root: unknown, options: FileGrantOptions = {}) {
  if (typeof root !== 'string') throw new TypeError('A filesystem root ID must be a string')
  try {
    parseRootId(root)
  } catch {
    throw new TypeError('Unknown filesystem root ID format: ' + JSON.stringify(root))
  }
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('File grant options must be an object')
  if (Object.keys(options).some((key) => key !== 'access'))
    throw new TypeError('Unknown file grant option')
  const access = Object.hasOwn(options, 'access') ? options.access : 'read'
  if (!FILE_ACCESS.includes(access as FileAccess))
    throw new TypeError('File grant access must be "read" or "read_write"')
  return { root, access: access as FileAccess }
}

function path(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('A grant path must be a string')
  try {
    return parseFilePath(value)
  } catch (error) {
    throw new TypeError((error as Error).message)
  }
}

function options(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('File operation options must be an object')
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TypeError('Unknown file operation option')
  return value as Record<string, unknown>
}

function safe(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(field + ' must be an integer between ' + min + ' and ' + max)
  return value
}

export type FileCall = {
  path: string
  operation: FileOperation
  finish: (result: FileResult) => unknown
}

const fileCalls = {
  stat(target: unknown): FileCall {
    return {
      path: path(target),
      operation: { kind: 'stat' },
      finish: (result) => {
        if (result.kind !== 'stat') throw new TypeError('unreachable')
        return Object.freeze({
          kind: result.file_kind,
          size: result.size,
          modifiedMs: result.modified_ms,
        })
      },
    }
  },
  list(target: unknown = '', value?: unknown): FileCall {
    const { after } = options(value, ['after'])
    if (after !== undefined && typeof after !== 'string')
      throw new TypeError('List `after` must be a file name')
    const operation: FileOperation =
      after === undefined ? { kind: 'list' } : { kind: 'list', after: path(after) }
    if (operation.kind === 'list' && (operation.after === '' || operation.after?.includes('/')))
      throw new TypeError('List `after` must be a single file name')
    return {
      path: path(target),
      operation,
      finish: (result) => {
        if (result.kind !== 'list') throw new TypeError('unreachable')
        return Object.freeze({
          entries: Object.freeze(result.entries.map((entry) => Object.freeze({ ...entry }))),
          complete: result.complete,
          omitted: result.omitted,
        })
      },
    }
  },
  read(target: unknown, value?: unknown): FileCall {
    const data = options(value, ['offset', 'length'])
    return {
      path: path(target),
      operation: {
        kind: 'read',
        offset: safe(
          data['offset'],
          'Read offset',
          0,
          Number.MAX_SAFE_INTEGER - MAX_FILE_CHUNK_BYTES,
          0
        ),
        length: safe(data['length'], 'Read length', 1, MAX_FILE_CHUNK_BYTES, MAX_FILE_CHUNK_BYTES),
      },
      finish: (result) => {
        if (result.kind !== 'read') throw new TypeError('unreachable')
        return Object.freeze({
          bytes: Uint8Array.fromBase64(result.data),
          endOfFile: result.end_of_file,
        })
      },
    }
  },
  write(target: unknown, bytes: unknown, value?: unknown): FileCall {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('File data must be a Uint8Array')
    if (bytes.byteLength > MAX_FILE_CHUNK_BYTES)
      throw new TypeError('File data exceeds ' + MAX_FILE_CHUNK_BYTES + ' bytes; write in chunks')
    const { mode = 'create' } = options(value, ['mode'])
    if (mode !== 'create' && mode !== 'truncate' && mode !== 'append')
      throw new TypeError('Write mode must be "create", "truncate" or "append"')
    const file = path(target)
    if (!file) throw new TypeError('The grant root itself cannot be written')
    return {
      path: file,
      operation: { kind: 'write', mode, data: bytes.toBase64() },
      finish: (result) => {
        if (result.kind !== 'written') throw new TypeError('unreachable')
        return result.bytes
      },
    }
  },
  createDirectory(target: unknown): FileCall {
    const file = path(target)
    if (!file) throw new TypeError('The grant root itself cannot be created')
    return { path: file, operation: { kind: 'create_directory' }, finish: () => undefined }
  },
  remove(target: unknown): FileCall {
    const file = path(target)
    if (!file) throw new TypeError('The grant root itself cannot be removed')
    return { path: file, operation: { kind: 'remove' }, finish: () => undefined }
  },
}

/** Internal registry entry. Consumers only receive its frozen handle. */
export class FileGrantRegistration {
  readonly handle: NativeFileGrant
  private revoked = false
  private closing: Promise<void> | undefined

  constructor(
    readonly id: number,
    readonly windowId: number,
    root: string,
    access: FileAccess,
    call: (registration: FileGrantRegistration, request: FileCall) => Promise<unknown>,
    close: (registration: FileGrantRegistration) => Promise<void>
  ) {
    const run = <T>(request: () => FileCall) => {
      try {
        return call(this, request()) as Promise<T>
      } catch (error) {
        return Promise.reject(error)
      }
    }
    const live = () => this.live
    this.handle = Object.freeze({
      root,
      access,
      get active() {
        return live()
      },
      stat: (target: string) => run<NativeFileStat>(() => fileCalls.stat(target)),
      list: (target?: string, value?: { readonly after?: string }) =>
        run<NativeDirectoryPage>(() => fileCalls.list(target, value)),
      read: (target: string, value?: { readonly offset?: number; readonly length?: number }) =>
        run<NativeFileChunk>(() => fileCalls.read(target, value)),
      write: (target: string, bytes: Uint8Array, value?: { readonly mode?: WriteMode }) =>
        run<number>(() => fileCalls.write(target, bytes, value)),
      createDirectory: (target: string) => run<void>(() => fileCalls.createDirectory(target)),
      remove: (target: string) => run<void>(() => fileCalls.remove(target)),
      close: () => {
        this.closing ??= this.revoked ? Promise.resolve() : close(this)
        return this.closing
      },
    })
  }

  get live(): boolean {
    return !this.revoked
  }

  revoke(): void {
    this.revoked = true
  }
}
