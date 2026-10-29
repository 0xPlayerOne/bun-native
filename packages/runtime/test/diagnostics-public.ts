import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import type { DiagnosticPolicy, DiagnosticRecord } from '@bunly/runtime'

test('runtime package entrypoint exposes the bounded diagnostics API', async () => {
  const require = createRequire(new URL('../package.json', import.meta.url))
  const runtime = await import(require.resolve('@bunly/runtime'))
  const policy: DiagnosticPolicy = { maxBytes: 512 }
  const records: DiagnosticRecord[] = [{ kind: 'reload-stage', message: 'token=secret' }]
  const bundle = runtime.collectDiagnosticBundle(records, policy)
  assert.equal(bundle.records[0]?.message, '[redacted]')
  assert.equal(bundle.bytes, Buffer.byteLength(JSON.stringify(bundle)))
  assert.equal(
    runtime.redactDiagnosticValue({ password: 'secret' }, policy)['[redacted]'],
    '[redacted]'
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
