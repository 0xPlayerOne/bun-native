import { BunlyError } from './core.ts'
import type { OperationOptions, PolicyScope } from './index.ts'

export const PROGRAMMATIC_FILE_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024,
  chunkBytes: 8192,
  stagingOverheadBytes: 256 * 1024,
  operations: 8,
  operationsPerView: 1,
  operationTimeoutMs: 8000,
} as const)

export type FileInteractionKind = 'file-input' | 'file-drop'
export interface ProgrammaticFile {
  /** One portable filename. Paths, directories and arbitrary disk reads are unsupported. */
  readonly name: string
  /** Explicit ASCII MIME type; the adapter does not infer content type. */
  readonly type: string
  /** Trusted application bytes, copied under a bounded reservation. */
  readonly bytes: Uint8Array
}
export interface FileInteractionRequest {
  readonly kind: FileInteractionKind
  /** Exact ID of one element in the current main document; no iframe selectors. */
  readonly elementId: string
  readonly file: ProgrammaticFile
}
export type FileInteractionFailure =
  | 'stale-target'
  | 'permission-denied'
  | 'unsupported-capability'
  | 'payload-too-large'
  | 'timeout'
  | 'adapter-error'
export interface FileInteractionResult {
  readonly status: 'completed' | 'cancelled' | 'failed'
  readonly failure: FileInteractionFailure | null
  readonly synthetic: true
  /** Conservative once commit is submitted. Cancellation cannot roll back a File
   * already exposed to the document or a request initiated by its event handlers.
   */
  readonly mayHaveExposedFile: boolean
}
export interface FileInteractionOperation {
  /** Settles after native cleanup, not after cancellation is merely accepted. */
  readonly completed: Promise<FileInteractionResult>
  /** Revalidates document authority and element identity before synthetic dispatch. */
  commit(): Promise<FileInteractionResult>
  cancel(): Promise<FileInteractionResult>
}
/** Optional development-only facet. Explicit current-document grants are required. */
export interface ProgrammaticFilesBackend {
  prepareFileInteraction(
    scope: PolicyScope,
    request: FileInteractionRequest,
    options?: OperationOptions
  ): Promise<FileInteractionOperation>
}

export function isFileInteractionElementId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.exec(value)?.[0] === value
}
export function isProgrammaticFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.exec(value)?.[0] === value &&
    !value.endsWith('.') &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  )
}
export function isProgrammaticMimeType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 127 &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.exec(value)?.[0] === value
  )
}
export function parseFileInteractionResult(value: unknown): FileInteractionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BunlyError('INVALID_ARGUMENT', 'Malformed native file-interaction result')
  const data = value as Record<string, unknown>
  const statuses = ['completed', 'cancelled', 'failed']
  const failures: readonly unknown[] = [
    'stale-target',
    'permission-denied',
    'unsupported-capability',
    'payload-too-large',
    'timeout',
    'adapter-error',
  ]
  if (
    Object.keys(data).sort().join(',') !== 'failure,mayHaveExposedFile,status,synthetic' ||
    typeof data['status'] !== 'string' ||
    !statuses.includes(data['status']) ||
    data['synthetic'] !== true ||
    typeof data['mayHaveExposedFile'] !== 'boolean' ||
    (data['status'] === 'failed'
      ? !failures.includes(data['failure'])
      : data['failure'] !== null) ||
    (data['status'] === 'completed' && data['mayHaveExposedFile'] !== true)
  )
    throw new BunlyError('INVALID_ARGUMENT', 'Malformed native file-interaction result')
  return Object.freeze({
    status: data['status'] as FileInteractionResult['status'],
    failure: data['failure'] as FileInteractionResult['failure'],
    synthetic: true,
    mayHaveExposedFile: data['mayHaveExposedFile'],
  })
}
