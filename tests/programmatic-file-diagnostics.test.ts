/** Portable diagnostics tests; these do not qualify actual native uploads. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { nativeDiagnosticLines } from '../benchmarks/lib/observed-command.ts'
import {
  FileFixtureDiagnostic,
  type UploadStep,
} from '../examples/programmatic-files/diagnostics.ts'
import type { UploadCase, UploadReceipt } from '../examples/programmatic-files/server.ts'

const privateValue = '/private/fixture/never-export-this-value'
const expected: UploadReceipt = {
  case: 'text',
  name: 'text.bin',
  mime: 'text/plain',
  bytes: 15,
  sha256: 'a'.repeat(64),
  cookie: 'partition=alpha',
  kind: 'file-input',
  trusted: false,
}
const ownerFields = [
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

test('file failure evidence identifies the last upload and exact assertion boundary', () => {
  const diagnostic = new FileFixtureDiagnostic()
  assert.deepEqual(diagnostic.failure('setup:Error'), {
    event: 'bunly.native.programmatic-files-diagnostic',
    schema: 1,
    phase: 'setup',
    error: 'Error',
    upload: null,
  })
  diagnostic.begin('text')
  diagnostic.result({
    status: 'completed',
    failure: null,
    synthetic: true,
    mayHaveExposedFile: true,
  })
  diagnostic.receipt({ ...expected }, expected)
  diagnostic.native(Object.fromEntries(ownerFields.map((key) => [key, 0])))
  diagnostic.step('native-owners-check')
  const evidence = diagnostic.failure('five-http-uploads:AssertionError')
  assert.equal(evidence.phase, 'five-http-uploads')
  assert.equal(evidence.error, 'AssertionError')
  assert.equal(evidence.upload!.case, 'text')
  assert.equal(evidence.upload!.step, 'native-owners-check')
  assert.deepEqual(evidence.upload!.result, {
    status: 'completed',
    failure: null,
    synthetic: true,
    mayHaveExposedFile: true,
  })
  assert.equal(Object.values(evidence.upload!.receiptMatches!).every(Boolean), true)
  assert.equal(
    Object.values(evidence.upload!.nativeOwners!).every((value) => value === 0),
    true
  )
  assert.equal(evidence.upload!.localOwners, null)
  const line = JSON.stringify(evidence)
  assert.deepEqual(nativeDiagnosticLines({ stderr: [], nativeDiagnostics: [line] }), [line])

  diagnostic.begin('maximum')
  assert.deepEqual(diagnostic.failure('five-http-uploads:Error').upload, {
    case: 'maximum',
    step: 'ready',
    result: null,
    receiptMatches: null,
    nativeOwners: null,
    localOwners: null,
  })
  assert.equal(evidence.upload!.case, 'text', 'Earlier snapshots remain independent')
})

test('each HTTP mismatch becomes only a finite equality bit', () => {
  for (const field of Object.keys(expected) as (keyof UploadReceipt)[]) {
    const diagnostic = new FileFixtureDiagnostic()
    diagnostic.begin('text')
    diagnostic.receipt({ ...expected, [field]: privateValue }, expected)
    diagnostic.step('http-fields')
    const evidence = diagnostic.failure('five-http-uploads:AssertionError')
    const matches = evidence.upload!.receiptMatches!
    assert.equal(matches.fields, true)
    for (const key of Object.keys(expected) as (keyof UploadReceipt)[])
      assert.equal(matches[key], key !== field)
    const encoded = JSON.stringify(evidence)
    for (const value of [
      privateValue,
      expected.name,
      expected.mime,
      expected.sha256,
      expected.cookie,
    ])
      assert.equal(encoded.includes(value), false)
  }
  const diagnostic = new FileFixtureDiagnostic()
  diagnostic.begin('text')
  diagnostic.receipt({ ...expected, [privateValue]: privateValue }, expected)
  assert.equal(
    diagnostic.failure('five-http-uploads:AssertionError').upload!.receiptMatches!.fields,
    false
  )
  assert.equal(
    JSON.stringify(diagnostic.failure('five-http-uploads:Error')).includes(privateValue),
    false
  )
})

test('owner snapshots are bounded independent scalars and preserve unknown values', () => {
  const diagnostic = new FileFixtureDiagnostic()
  diagnostic.begin('text')
  const native: Record<string, unknown> = Object.fromEntries(
    ownerFields.map((key) => [key, 0xffff_ffff])
  )
  const local = { operations: 0, bytes: 15, privateValue }
  const result = {
    status: 'failed',
    failure: 'stale-target',
    synthetic: true,
    mayHaveExposedFile: true,
    privateValue,
  }
  diagnostic.native(native)
  diagnostic.local(local)
  diagnostic.result(result)
  native['operations'] = -1
  local.bytes = 99
  result.failure = privateValue
  const evidence = diagnostic.failure('five-http-uploads:AssertionError')
  assert.equal(evidence.upload!.nativeOwners!.operations, 0xffff_ffff)
  assert.deepEqual(evidence.upload!.localOwners, { operations: 0, bytes: 15 })
  assert.equal(evidence.upload!.result!.failure, 'stale-target')
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 2048)
  assert.equal(JSON.stringify(evidence).includes(privateValue), false)
  for (const invalid of [-1, 1.5, Infinity, NaN, 0x1_0000_0000, '0', true, undefined]) {
    diagnostic.native({ operations: invalid })
    diagnostic.local({ operations: invalid, bytes: invalid })
    const invalidEvidence = diagnostic.failure('five-http-uploads:Error').upload!
    assert.equal(
      Object.values(invalidEvidence.nativeOwners!).every((value) => value === null),
      true
    )
    assert.deepEqual(invalidEvidence.localOwners, { operations: null, bytes: null })
  }
})

test('unrecognized cases, stages, errors and terminal fields cannot export arbitrary strings', () => {
  const diagnostic = new FileFixtureDiagnostic()
  diagnostic.begin(privateValue as UploadCase)
  diagnostic.step(privateValue as UploadStep)
  diagnostic.result({
    status: privateValue,
    failure: privateValue,
    synthetic: 'true',
    mayHaveExposedFile: 1,
  })
  for (const failure of [privateValue, 'x'.repeat(129), null]) {
    const evidence = diagnostic.failure(failure)
    assert.equal(evidence.phase, 'unclassified')
    assert.equal(evidence.error, 'unclassified')
    assert.equal(evidence.upload!.case, 'unclassified')
    assert.equal(evidence.upload!.step, 'unclassified')
    assert.deepEqual(evidence.upload!.result, {
      status: 'unclassified',
      failure: 'unclassified',
      synthetic: null,
      mayHaveExposedFile: null,
    })
    assert.equal(JSON.stringify(evidence).includes(privateValue), false)
  }
  const partial = diagnostic.failure('five-http-uploads:' + privateValue)
  assert.equal(partial.phase, 'five-http-uploads')
  assert.equal(partial.error, 'unclassified')
  assert.equal(JSON.stringify(partial).includes(privateValue), false)
})
