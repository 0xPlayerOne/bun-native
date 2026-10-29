import { test } from 'bun:test'
import assert from 'node:assert/strict'
import * as runtime from '@bunly/runtime'
import type { DiagnosticPolicy, DiagnosticRecord } from '@bunly/runtime'

test('runtime package entrypoint exposes the bounded diagnostics API', () => {
  const policy: DiagnosticPolicy = { maxBytes: 512 }
  const records: DiagnosticRecord[] = [{ kind: 'reload-stage', message: 'token=secret' }]
  const bundle = runtime.collectDiagnosticBundle(records, policy)
  assert.equal(bundle.records[0]?.message, '[redacted]')
  assert.equal(bundle.bytes, Buffer.byteLength(JSON.stringify(bundle)))
  assert.deepEqual(
    Object.entries(runtime.redactDiagnosticValue({ password: 'secret' }, policy) as object),
    [['[redacted]', '[redacted]']]
  )
  assert.deepEqual(
    runtime.renderSourceMappedFrame({ file: 'app.js', line: 1, column: 1 }, undefined),
    {
      file: 'app.js',
      line: 1,
      column: 1,
    }
  )
})
