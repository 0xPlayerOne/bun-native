import {
  ProtocolError,
  parseFileDialogOptions,
  type FileDialogMode,
  type FileDialogOptions,
  type FileDialogResult,
} from '@bun-native/protocol'
import { NativeServiceError } from './services.ts'

export interface FileDialogFilter {
  /** Shown to the user, e.g. `Text`. At most 128 UTF-8 bytes. */
  readonly name: string
  /** Shell-style globs such as `*.txt`; 1-16 of at most 64 bytes each. */
  readonly patterns: readonly string[]
}

interface CommonDialogOptions {
  /** One nonempty line of at most 256 UTF-8 bytes. */
  readonly title: string
  /** The accept button's label; the platform default when absent. */
  readonly acceptLabel?: string
  /** An absolute starting folder. A hint the platform may ignore. */
  readonly folder?: string
  /** At most 16 filters. */
  readonly filters?: readonly FileDialogFilter[]
}

export interface OpenDialogOptions extends CommonDialogOptions {
  /** `file` (default) picks one file, `files` one or more, `directory` one folder. */
  readonly select?: 'file' | 'files' | 'directory'
}

export interface SaveDialogOptions extends CommonDialogOptions {
  /** The suggested file name: one path component of at most 255 bytes. */
  readonly name?: string
}

/**
 * Absolute paths the user chose. They are data, not authority: a path does not
 * grant filesystem access through Bun Native, and converting it into a scoped
 * filesystem grant is a separate, explicit operation.
 */
export type OpenDialogResult =
  | Readonly<{ kind: 'selected'; paths: readonly string[] }>
  | Readonly<{ kind: 'cancelled' }>
export type SaveDialogResult =
  | Readonly<{ kind: 'selected'; path: string }>
  | Readonly<{ kind: 'cancelled' }>

const OPEN_KEYS = ['title', 'acceptLabel', 'folder', 'filters', 'select']
const SAVE_KEYS = ['title', 'acceptLabel', 'folder', 'filters', 'name']
const SELECT_MODES = {
  file: 'open_file',
  files: 'open_files',
  directory: 'open_directory',
} as const

function wireOptions(
  options: unknown,
  allowed: readonly string[],
  mode: (data: Record<string, unknown>) => FileDialogMode
): FileDialogOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('File dialog options must be an object')
  const data = options as Record<string, unknown>
  if (Object.keys(data).some((key) => !allowed.includes(key)))
    throw new TypeError('Unknown file dialog option')
  const filters = data['filters']
  if (filters !== undefined && !Array.isArray(filters))
    throw new TypeError('File dialog filters must be an array')
  const wire: Record<string, unknown> = { mode: mode(data), title: data['title'] }
  if (data['acceptLabel'] !== undefined) wire['accept_label'] = data['acceptLabel']
  if (data['folder'] !== undefined) wire['folder'] = data['folder']
  if (data['name'] !== undefined) wire['name'] = data['name']
  if (filters?.length)
    wire['filters'] = filters.map((filter: unknown) => {
      if (!filter || typeof filter !== 'object' || Array.isArray(filter))
        throw new TypeError('A file dialog filter must be an object')
      const { name, patterns } = filter as Record<string, unknown>
      if (Object.keys(filter).some((key) => key !== 'name' && key !== 'patterns'))
        throw new TypeError('Unknown file dialog filter option')
      return { name, patterns: Array.isArray(patterns) ? [...patterns] : patterns }
    })
  try {
    // One shared validator for both language implementations' bounds.
    return parseFileDialogOptions(wire)
  } catch (error) {
    if (error instanceof ProtocolError) throw new TypeError(error.message)
    throw error
  }
}

export function openDialogRequest(options: OpenDialogOptions): FileDialogOptions {
  return wireOptions(options, OPEN_KEYS, (data) => {
    const select = data['select'] ?? 'file'
    if (select !== 'file' && select !== 'files' && select !== 'directory')
      throw new TypeError('File dialog select must be file, files or directory')
    return SELECT_MODES[select]
  })
}

export function saveDialogRequest(options: SaveDialogOptions): FileDialogOptions {
  return wireOptions(options, SAVE_KEYS, () => 'save_file')
}

/** Internal registry entry for one live native dialog. */
export class FileDialogRequest {
  readonly result: Promise<FileDialogResult>
  private resolve!: (result: FileDialogResult) => void
  private reject!: (error: Error) => void
  private settled = false

  constructor(
    readonly id: number,
    readonly windowId: number,
    readonly mode: FileDialogMode
  ) {
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    // The caller may not await before revocation rejects it.
    void this.result.catch(() => {})
  }

  get live(): boolean {
    return !this.settled
  }

  complete(result: FileDialogResult): void {
    if (this.settled) return
    if (result.kind === 'selected' && this.mode !== 'open_files' && result.paths.length !== 1)
      throw new ProtocolError('A single-selection file dialog returned several paths')
    this.settled = true
    if (result.kind === 'failed')
      this.reject(
        new NativeServiceError(
          'file_dialogs',
          result.code,
          result.code === 'payload_too_large'
            ? 'The selection does not fit one native message'
            : 'The native file dialog failed'
        )
      )
    else this.resolve(result)
  }

  fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    this.reject(error)
  }
}
