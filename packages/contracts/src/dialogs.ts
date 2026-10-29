import { BunlyError } from './core.ts'
import type { OperationOptions } from './index.ts'
import type { PolicyScope } from './desktop.ts'

export const FILE_DIALOG_LIMITS = Object.freeze({
  titleBytes: 256,
  nameBytes: 255,
  pathBytes: 4096,
})

export interface OpenFileDialogOptions {
  readonly title?: string
  /** Explicit starting directory. This does not constrain the user's selection. */
  readonly directory: string
}
export interface SaveFileDialogOptions extends OpenFileDialogOptions {
  /** A single suggested basename. Selecting a path does not write or overwrite it. */
  readonly suggestedName: string
}
export type FileDialogResult =
  | { readonly status: 'selected'; readonly path: string }
  | { readonly status: 'cancelled' }

/** Optional trusted-host selection. No renderer upload or filesystem permission is implied. */
export interface FileDialogBackend {
  showOpenFileDialog(
    scope: PolicyScope,
    dialog: OpenFileDialogOptions,
    options?: OperationOptions
  ): Promise<FileDialogResult>
  showSaveFileDialog(
    scope: PolicyScope,
    dialog: SaveFileDialogOptions,
    options?: OperationOptions
  ): Promise<FileDialogResult>
}

function text(value: unknown, maximum: number): value is string {
  if (typeof value !== 'string' || value.length > maximum) return false
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) return false
    if (unit >= 0xdc00 && unit <= 0xdfff) return false
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      bytes += 4
    } else bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3
    if (bytes > maximum) return false
  }
  return true
}
export function normalizeFileDialog(
  kind: 'open' | 'save',
  value: unknown
): Readonly<{ title: string; suggestedName: string; directory: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BunlyError('INVALID_ARGUMENT', 'Expected file dialog options')
  const object = value as Record<string, unknown>
  if (
    Object.keys(object).some(
      (key) =>
        key !== 'title' && key !== 'directory' && !(kind === 'save' && key === 'suggestedName')
    )
  )
    throw new BunlyError('INVALID_ARGUMENT', 'Unexpected file dialog option')
  const title = object['title'] ?? ''
  const suggestedName = kind === 'save' ? object['suggestedName'] : ''
  const directory = object['directory']
  if (
    !text(title, FILE_DIALOG_LIMITS.titleBytes) ||
    !validSelectedFilePath(directory) ||
    !text(suggestedName, FILE_DIALOG_LIMITS.nameBytes) ||
    (kind === 'save' &&
      (!suggestedName ||
        suggestedName === '.' ||
        suggestedName === '..' ||
        /[\\/:]/u.test(suggestedName)))
  )
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid file dialog title or suggested basename')
  return Object.freeze({ title, suggestedName, directory })
}

/** Validation only; a returned path is not a transferable file-access capability. */
export function validSelectedFilePath(value: unknown): value is string {
  return (
    text(value, FILE_DIALOG_LIMITS.pathBytes) &&
    value.startsWith('/') &&
    !value.split('/').includes('..') &&
    !value.split('/').includes('.')
  )
}
