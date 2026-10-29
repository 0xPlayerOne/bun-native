/** Failure-only fixture evidence. Never retain received fields, payloads, errors,
 * filenames, hashes, cookies, targets or CEF owners in the diagnostic state.
 */
import { uploadCases, type UploadCase, type UploadReceipt } from './server.ts'

const steps = [
  'ready',
  'grant',
  'prepare',
  'commit',
  'commit-result',
  'http-receipt',
  'http-fields',
  'native-owners-read',
  'native-owners-check',
  'local-owners-read',
  'local-owners-check',
  'complete',
] as const
export type UploadStep = (typeof steps)[number]
const phases = [
  'setup',
  'denial',
  'five-http-uploads',
  'cancel-before-commit',
  'reload-revocation',
  'navigation-race',
  'close-prepared-view',
  'partial-exposure',
  'shutdown',
  'http-receipts',
  'workload-deadline',
  'final-views',
  'final-windows',
  'final-sessions',
  'final-listeners',
  'final-listenerErrors',
] as const
const errors = [
  'Error',
  'AssertionError',
  'BunlyError',
  'AbortError',
  'TimeoutError',
  'TypeError',
  'RangeError',
] as const
const failures = [
  'stale-target',
  'permission-denied',
  'unsupported-capability',
  'payload-too-large',
  'timeout',
  'adapter-error',
] as const
const nativeFields = [
  'operations',
  'registrations',
  'callbacks',
  'privateControllers',
  'objectGroups',
  'chunkBytes',
  'reservedBytes',
  'deadlineWorkers',
  'admitted',
  'prepared',
  'committed',
  'dispatched',
  'completed',
  'released',
] as const
const localFields = ['operations', 'bytes'] as const
const receiptFields = [
  'case',
  'name',
  'mime',
  'bytes',
  'sha256',
  'cookie',
  'kind',
  'trusted',
] as const
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const label = <T extends string>(labels: readonly T[], value: unknown): T | 'unclassified' =>
  typeof value === 'string' && labels.includes(value as T) ? (value as T) : 'unclassified'
const boolean = (value: unknown) => (typeof value === 'boolean' ? value : null)
const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
    ? value
    : null
const counts = <T extends string>(value: unknown, fields: readonly T[]) =>
  Object.freeze(
    Object.fromEntries(fields.map((key) => [key, count(object(value)[key])])) as Record<
      T,
      number | null
    >
  )
function result(value: unknown) {
  const received = object(value)
  return Object.freeze({
    status: label(['completed', 'cancelled', 'failed'] as const, received['status']),
    failure: received['failure'] === null ? null : label(failures, received['failure']),
    synthetic: boolean(received['synthetic']),
    mayHaveExposedFile: boolean(received['mayHaveExposedFile']),
  })
}
interface UploadTrace {
  readonly case: UploadCase | 'unclassified'
  readonly step: UploadStep | 'unclassified'
  readonly result: ReturnType<typeof result> | null
  readonly receiptMatches: Readonly<
    Record<(typeof receiptFields)[number] | 'fields', boolean>
  > | null
  readonly nativeOwners: Readonly<Record<(typeof nativeFields)[number], number | null>> | null
  readonly localOwners: Readonly<Record<(typeof localFields)[number], number | null>> | null
}
export class FileFixtureDiagnostic {
  #upload: UploadTrace | null = null
  begin(name: UploadCase): void {
    this.#upload = {
      case: label(uploadCases, name),
      step: 'ready',
      result: null,
      receiptMatches: null,
      nativeOwners: null,
      localOwners: null,
    }
  }
  step(value: UploadStep): void {
    if (this.#upload) this.#upload = { ...this.#upload, step: label(steps, value) }
  }
  result(value: unknown): void {
    if (this.#upload) this.#upload = { ...this.#upload, result: result(value) }
  }
  receipt(value: unknown, expected: UploadReceipt): void {
    if (!this.#upload) return
    const received = object(value)
    const fields = Object.keys(received)
    this.#upload = {
      ...this.#upload,
      receiptMatches: Object.freeze({
        fields:
          fields.length === receiptFields.length &&
          receiptFields.every((key) => fields.includes(key)),
        ...Object.fromEntries(receiptFields.map((key) => [key, received[key] === expected[key]])),
      }) as UploadTrace['receiptMatches'],
    }
  }
  native(value: unknown): void {
    if (this.#upload) this.#upload = { ...this.#upload, nativeOwners: counts(value, nativeFields) }
  }
  local(value: unknown): void {
    if (this.#upload) this.#upload = { ...this.#upload, localOwners: counts(value, localFields) }
  }
  failure(value: unknown) {
    const parts = typeof value === 'string' && value.length <= 128 ? value.split(':') : []
    return Object.freeze({
      event: 'bunly.native.programmatic-files-diagnostic',
      schema: 1,
      phase: label(phases, parts.length === 2 ? parts[0] : undefined),
      error: label(errors, parts.length === 2 ? parts[1] : undefined),
      upload: this.#upload && Object.freeze({ ...this.#upload }),
    })
  }
}
