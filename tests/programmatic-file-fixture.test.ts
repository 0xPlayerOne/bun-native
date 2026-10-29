/** HTTP and receipt validation tests; these do not qualify native CEF behavior. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileFixtureServer } from '../examples/programmatic-files/server.ts'
import { acceptProgrammaticFileReceipt } from '../scripts/qualify-programmatic-files.ts'

function receipt() {
  const cases = [
    [
      'text',
      'text/plain',
      new TextEncoder().encode('fixture text Ω'),
      'partition=alpha',
      'file-input',
    ],
    [
      'maximum',
      'application/octet-stream',
      Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 17 + 31) % 256),
      'partition=alpha',
      'file-input',
    ],
    ['empty', 'application/x-empty', new Uint8Array(), 'partition=alpha', 'file-drop'],
    [
      'isolated',
      'application/octet-stream',
      new Uint8Array([0, 255, 128, 1]),
      'partition=beta',
      'file-input',
    ],
    [
      'drop',
      'application/x-bunly-fixture',
      new Uint8Array([7, 9, 11]),
      'partition=beta',
      'file-drop',
    ],
  ] as const
  return {
    event: 'bunly.native.programmatic-files',
    schema: 1,
    passed: true,
    failure: null,
    workloadMs: 1000,
    checks: Object.fromEntries(
      [
        'exactGrantDenial',
        'fiveUploads',
        'mimeAndHashes',
        'cookiePartitions',
        'oneMiBBoundary',
        'syntheticInputAndDrop',
        'cancelBeforeCommit',
        'reloadRevokesGrant',
        'navigationSettled',
        'closeSettled',
        'partialExposureReported',
        'zeroOwners',
      ].map((key) => [key, true])
    ),
    uploads: cases.map(([name, mime, bytes, cookie, kind]) => ({
      case: name,
      name: name + '.bin',
      mime,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      cookie,
      kind,
      trusted: false,
    })),
    partialExposure: {
      status: 'failed',
      failure: 'stale-target',
      synthetic: true,
      mayHaveExposedFile: true,
    },
    nativeSettled: {
      operations: 0,
      registrations: 0,
      callbacks: 0,
      privateControllers: 0,
      objectGroups: 0,
      chunkBytes: 0,
      reservedBytes: 0,
      deadlineWorkers: 0,
      admitted: 10,
      prepared: 10,
      committed: 6,
      dispatched: 5,
      completed: 5,
      released: 10,
    },
    localSettled: { operations: 0, bytes: 0 },
    final: { views: 0, windows: 0, sessions: 0, listeners: 0, listenerErrors: 0 },
    synthetic: true,
    osPickerQualified: false,
    physicalDropQualified: false,
    rollbackGuaranteed: false,
    performanceEligible: false,
  }
}
test('programmatic-file receipt requires five exact HTTP hashes, MIME types and cookie partitions', () => {
  const valid = receipt()
  acceptProgrammaticFileReceipt(valid)
  for (const field of ['name', 'mime', 'sha256', 'cookie', 'kind'] as const) {
    const changed = structuredClone(valid)
    Object.assign(changed.uploads[0]!, { [field]: 'wrong' })
    assert.throws(() => acceptProgrammaticFileReceipt(changed))
  }
  const missing = structuredClone(valid)
  missing.uploads.pop()
  assert.throws(() => acceptProgrammaticFileReceipt(missing))
})
test('file receipt rejects retained owners, false rollback and expanded qualification claims', () => {
  const valid = receipt()
  for (const field of [
    'operations',
    'registrations',
    'callbacks',
    'privateControllers',
    'objectGroups',
    'chunkBytes',
    'reservedBytes',
    'deadlineWorkers',
  ] as const) {
    const changed = structuredClone(valid)
    changed.nativeSettled[field] = 1
    assert.throws(() => acceptProgrammaticFileReceipt(changed))
  }
  for (const field of [
    'osPickerQualified',
    'physicalDropQualified',
    'rollbackGuaranteed',
    'performanceEligible',
  ] as const) {
    const changed = structuredClone(valid)
    changed[field] = true
    assert.throws(() => acceptProgrammaticFileReceipt(changed))
  }
  for (const change of [
    { localSettled: { operations: 1, bytes: 1 } },
    { partialExposure: { ...valid.partialExposure, mayHaveExposedFile: false } },
    { checks: { ...valid.checks, closeSettled: false } },
    { workloadMs: 45_000 },
    { extra: '/private/unrequested' },
  ])
    assert.throws(() => acceptProgrammaticFileReceipt({ ...valid, ...change }))
})
test('temporary upload peer verifies real multipart bytes and retains only bounded receipts', async () => {
  const server = fileFixtureServer()
  const body = () => {
    const data = new FormData()
    data.append(
      'file',
      new File([new Uint8Array([0, 255, 128, 1])], 'isolated.bin', {
        type: 'application/octet-stream',
      })
    )
    data.append('kind', 'file-input')
    data.append('trusted', 'false')
    return data
  }
  try {
    const options = () => ({ method: 'POST', headers: { cookie: 'partition=beta' }, body: body() })
    assert.equal((await fetch(server.origin + '/upload/isolated', options())).status, 200)
    assert.deepEqual(await server.receipt('isolated'), receipt().uploads[3])
    assert.equal((await fetch(server.origin + '/upload/isolated', options())).status, 400)
    assert.equal((await fetch(server.origin + '/upload/unowned', options())).status, 400)
    const snapshot = server.snapshot()
    assert.equal(snapshot.uploads.length, 1)
    assert.deepEqual(snapshot.failures, ['invalid-fixture-request', 'invalid-fixture-request'])
    assert.equal('data' in snapshot.uploads[0]!, false)
    assert.equal((await fetch(server.origin + '/document/unowned')).status, 404)
  } finally {
    await server.stop()
  }
})

test('upload peer records the multipart media type instead of inferring it from the filename', async () => {
  const server = fileFixtureServer()
  try {
    for (const [name, type] of [
      ['text', 'text/plain'],
      ['isolated', 'image/png'],
    ] as const) {
      const data = new FormData()
      const bytes = new TextEncoder().encode(
        'sample\r\nContent-Type: application/octet-stream\r\n\r\n'
      )
      data.append('file', new File([bytes], `${name}.bin`, { type }))
      data.append('kind', 'file-input')
      data.append('trusted', 'false')
      const response = await fetch(server.origin + '/upload/' + name, {
        method: 'POST',
        headers: { cookie: 'partition=alpha' },
        body: data,
      })
      assert.equal(response.status, 200)
      const observed = await server.receipt(name)
      assert.equal(observed.mime, type)
      assert.equal(observed.sha256, createHash('sha256').update(bytes).digest('hex'))
    }
  } finally {
    await server.stop()
  }
})

test('upload peer rejects duplicate file media headers', async () => {
  const server = fileFixtureServer()
  try {
    const body = [
      '--fixture',
      'Content-Disposition: form-data; name="file"; filename="text.bin"',
      'Content-Type: text/plain',
      'Content-Type: application/octet-stream',
      '',
      'fixture text',
      '--fixture--',
      '',
    ].join('\r\n')
    const response = await fetch(server.origin + '/upload/text', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=fixture',
        cookie: 'partition=alpha',
      },
      body,
    })
    assert.equal(response.status, 400)
    assert.deepEqual(server.snapshot().uploads, [])
  } finally {
    await server.stop()
  }
})
