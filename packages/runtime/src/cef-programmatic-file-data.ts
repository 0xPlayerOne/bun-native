import { createHash } from 'node:crypto'
import { BunlyError } from '../../contracts/src/core.ts'
import {
  PROGRAMMATIC_FILE_LIMITS as LIMITS,
  isFileInteractionElementId,
  isProgrammaticFileName,
  isProgrammaticMimeType,
  type FileInteractionKind,
} from '../../contracts/src/programmatic-files.ts'

const Uint8 = Uint8Array
const arrayPrototype = Object.getPrototypeOf(Uint8.prototype) as object
const intrinsic = (key: PropertyKey) => Object.getOwnPropertyDescriptor(arrayPrototype, key)!.get!
const byteLength = intrinsic('byteLength')
const byteOffset = intrinsic('byteOffset')
const buffer = intrinsic('buffer')
const tag = intrinsic(Symbol.toStringTag)
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!
const setBytes = Uint8.prototype.set

export interface FileInteractionMetadata {
  readonly kind: FileInteractionKind
  readonly elementId: string
  readonly name: string
  readonly mime: string
  readonly bytes: number
  readonly sha256: string
}

function fields(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BunlyError('INVALID_ARGUMENT', 'Expected file-interaction options')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(descriptors).length !== expected.length ||
    expected.some((key) => !descriptors[key] || !('value' in descriptors[key]!))
  )
    throw new BunlyError('INVALID_ARGUMENT', 'Unexpected or accessor file-interaction option')
  return Object.fromEntries(expected.map((key) => [key, descriptors[key]!.value]))
}

type OwnedFile = {
  readonly metadata: FileInteractionMetadata
  readonly data: Uint8Array
}
export function fileInteractionReservation(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > LIMITS.fileBytes)
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid file byte reservation')
  // SDK snapshot + private isolated-world buffer, plus bounded IPC/chunk owners.
  return 2 * bytes + LIMITS.stagingOverheadBytes
}
/** Inspection borrows only intrinsic dimensions; call copy after reserving the
 * joint quota. No caller .length/.buffer getter, iterator, or species is used.
 */
export function inspectProgrammaticFile(
  value: unknown
): Readonly<{ bytes: number; copy(): OwnedFile }> {
  const input = fields(value, ['kind', 'elementId', 'file'])
  const file = fields(input['file'], ['name', 'type', 'bytes'])
  if (
    typeof input['kind'] !== 'string' ||
    !['file-input', 'file-drop'].includes(input['kind']) ||
    !isFileInteractionElementId(input['elementId']) ||
    !isProgrammaticFileName(file['name']) ||
    !isProgrammaticMimeType(file['type'])
  )
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid file-interaction metadata')
  let length: number, offset: number, backing: ArrayBuffer
  try {
    const source = file['bytes']
    if (tag.call(source) !== 'Uint8Array') throw new Error('Expected Uint8Array')
    length = byteLength.call(source) as number
    offset = byteOffset.call(source) as number
    backing = buffer.call(source) as ArrayBuffer
    // Reject SharedArrayBuffer: no atomic snapshot or concurrent mutation claim.
    const backingLength: number = arrayBufferLength.call(backing)
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > LIMITS.fileBytes ||
      offset + length > backingLength
    )
      throw new Error('File byte limit')
    // Constructing the bounded source view also rejects a detached ArrayBuffer.
    new Uint8(backing, offset, length)
  } catch {
    throw new BunlyError(
      'INVALID_ARGUMENT',
      'File bytes require an attached, unshared Uint8Array of at most 1 MiB'
    )
  }
  const metadata = Object.freeze({
    kind: input['kind'] as FileInteractionKind,
    elementId: input['elementId'],
    name: file['name'],
    mime: file['type'],
    bytes: length,
  })
  return Object.freeze({
    bytes: length,
    copy: () => {
      const sourceView = new Uint8(backing, offset, length)
      const data = new Uint8(length)
      setBytes.call(data, sourceView)
      return Object.freeze({
        metadata: Object.freeze({
          ...metadata,
          sha256: createHash('sha256').update(data).digest('hex'),
        }),
        data,
      })
    },
  })
}
export function copyProgrammaticFile(value: unknown): OwnedFile {
  return inspectProgrammaticFile(value).copy()
}
