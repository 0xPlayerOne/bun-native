import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  copyProgrammaticFile,
  fileInteractionReservation,
} from '../packages/runtime/src/cef-programmatic-file-data.ts'
import { CefViewControlBudget } from '../packages/runtime/src/cef-view-control-budget.ts'
import {
  PROGRAMMATIC_FILE_LIMITS as LIMITS,
  parseFileInteractionResult,
} from '../packages/contracts/src/programmatic-files.ts'

const request = (bytes: unknown = new Uint8Array([0, 127, 128, 255])) => ({
  kind: 'file-input',
  elementId: 'file-input',
  file: { name: 'fixture.bin', type: 'application/octet-stream', bytes },
})

test('programmatic bytes use an independent bounded snapshot and exact SHA256', () => {
  const source = new Uint8Array([0, 127, 128, 255])
  const copied = copyProgrammaticFile(request(source))
  assert.deepEqual([...copied.data], [...source])
  assert.equal(copied.metadata.sha256, createHash('sha256').update(source).digest('hex'))
  source.fill(3)
  assert.deepEqual([...copied.data], [0, 127, 128, 255])
  assert.equal(copyProgrammaticFile(request(new Uint8Array())).metadata.bytes, 0)
  assert.equal(
    copyProgrammaticFile(request(new Uint8Array(LIMITS.fileBytes))).metadata.bytes,
    LIMITS.fileBytes
  )
  assert.equal(fileInteractionReservation(LIMITS.fileBytes), 2 * LIMITS.fileBytes + 256 * 1024)
})

test('intrinsic typed-array dimensions reject forged lengths without invoking getters', () => {
  let reads = 0
  const oversized = new Uint8Array(LIMITS.fileBytes + 1)
  for (const field of ['length', 'byteLength', 'byteOffset', 'buffer'])
    Object.defineProperty(oversized, field, {
      get() {
        reads++
        return 0
      },
    })
  assert.throws(() => copyProgrammaticFile(request(oversized)), /at most 1 MiB/)
  assert.equal(reads, 0)
  const small = new Uint8Array([5, 6])
  Object.defineProperty(small, 'byteLength', {
    get() {
      reads++
      return 2 ** 40
    },
  })
  assert.deepEqual([...copyProgrammaticFile(request(small)).data], [5, 6])
  assert.equal(reads, 0)
})

test('proxies, forged brands, shared memory and detached buffers cannot supply file bytes', () => {
  const detached = new Uint8Array([1])
  structuredClone(detached.buffer, { transfer: [detached.buffer] })
  for (const source of [
    new Proxy(new Uint8Array(3), {}),
    new Uint16Array(2),
    new DataView(new ArrayBuffer(2)),
    { [Symbol.toStringTag]: 'Uint8Array', length: 1 },
    new Uint8Array(new SharedArrayBuffer(2)),
    detached,
  ])
    assert.throws(() => copyProgrammaticFile(request(source)))
})

test('file requests reject filesystem paths, metadata coercion and accessor fields', () => {
  for (const invalid of [
    { ...request(), path: '/unrelated/file' },
    { ...request(), kind: { toString: () => 'file-input' } },
    { ...request(), elementId: 'target\n' },
    { ...request(), elementId: 'iframe input' },
    { ...request(), file: { ...request().file, path: '/unrelated/file' } },
    { ...request(), file: { ...request().file, name: '../file' } },
    { ...request(), file: { ...request().file, name: 'CON.txt' } },
    { ...request(), file: { ...request().file, name: 'file\n' } },
    { ...request(), file: { ...request().file, type: 'text/plain\n' } },
    { ...request(), file: { ...request().file, type: 'text/plain;param=value' } },
    { ...request(), [Symbol('hidden')]: true },
  ])
    assert.throws(() => copyProgrammaticFile(invalid))
  let read = false
  const accessor = {
    ...request().file,
    get bytes() {
      read = true
      return new Uint8Array(1)
    },
  }
  assert.throws(() => copyProgrammaticFile({ ...request(), file: accessor }))
  assert.equal(read, false)
})

test('shared view-control reservation prevents cross-controller overlap and stale release', () => {
  const budget = new CefViewControlBudget()
  const browser = budget.reserve(1, 3 * LIMITS.fileBytes)
  assert.throws(() => budget.reserve(1, LIMITS.fileBytes), /capacity/)
  const files = Array.from({ length: 5 }, (_, index) => budget.reserve(index + 2, LIMITS.fileBytes))
  assert.deepEqual(budget.diagnostics(), { operations: 6, bytes: 8 * LIMITS.fileBytes })
  assert.throws(() => budget.reserve(8, LIMITS.fileBytes), /capacity/)
  browser.release()
  const replacement = budget.reserve(1, LIMITS.fileBytes)
  browser.release()
  assert.equal(budget.diagnostics().operations, 6)
  replacement.release()
  for (const file of files) file.release()
  const eight = Array.from({ length: 8 }, (_, index) => budget.reserve(index + 1, 1))
  assert.throws(() => budget.reserve(9, 1), /capacity/)
  for (const lease of eight) lease.release()
  assert.deepEqual(budget.diagnostics(), { operations: 0, bytes: 0 })
})

test('file result distinguishes confirmed synthetic dispatch from uncertain cancellation', () => {
  const completed = {
    status: 'completed',
    failure: null,
    synthetic: true,
    mayHaveExposedFile: true,
  }
  assert.deepEqual(parseFileInteractionResult(completed), completed)
  assert.throws(() => parseFileInteractionResult({ ...completed, mayHaveExposedFile: false }))
  assert.throws(() => parseFileInteractionResult({ ...completed, synthetic: false }))
  assert.throws(() => parseFileInteractionResult({ ...completed, rollback: true }))
  for (const exposed of [false, true]) {
    assert.equal(
      parseFileInteractionResult({ ...completed, status: 'cancelled', mayHaveExposedFile: exposed })
        .mayHaveExposedFile,
      exposed
    )
    assert.equal(
      parseFileInteractionResult({
        ...completed,
        status: 'failed',
        failure: 'stale-target',
        mayHaveExposedFile: exposed,
      }).failure,
      'stale-target'
    )
  }
})
