import assert from 'node:assert/strict'
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function count(value: unknown, max: number) {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max)
  return value
}
/** Functional-only receipt validation. Never promotes callback checksums to child-byte or renderer parity. */
export function acceptBunPty(input: unknown): void {
  const report = object(input)
  assert.equal(report['schema'], 1)
  assert.equal(report['classification'], 'real-bun-pty-to-portable-stream-functional')
  assert.equal(report['passed'], true)
  assert.equal(report['bun'], '1.4.3')
  assert.ok(['darwin-arm64', 'linux-x64', 'win32-x64'].includes(String(report['target'])))
  assert.deepEqual(report['sourcePauseResume'], {
    available: false,
    policy: 'bounded-callback-queue-or-explicit-stop',
  })
  const cases = report['cases']
  assert.ok(Array.isArray(cases))
  assert.equal(cases.length, 3)
  assert.deepEqual(
    cases.map((row) => object(row)['name']),
    ['ordered', 'cancelled', 'overloaded']
  )
  for (const item of cases) {
    const row = object(item)
    assert.equal(row['passed'], true)
    assert.equal(row['reservationsReleased'], true)
    count(row['peakRetainedBytes'], row['name'] === 'overloaded' ? 4096 : 128 * 1024)
    if (row['name'] === 'ordered') {
      for (const flag of [
        'tty',
        'input',
        'consumptionAcknowledged',
        'controlWhilePaused',
        'terminalClosureAndChildExitObserved',
      ])
        assert.equal(row[flag], true)
      assert.equal(row['consumer'], 'xterm-headless-5.5.0-parser-callback')
      assert.equal(row['unicodeObserved'], true)
      const terminalCode = row['terminalLifecycleCode']
      assert.ok(terminalCode === 0 || (report['target'] === 'linux-x64' && terminalCode === 1))
      assert.equal(row['cleanTerminalEof'], terminalCode === 0)
      assert.equal(
        row['terminalClosure'],
        terminalCode === 0 ? 'clean-eof' : 'read-error-status-with-complete-known-fixture'
      )
      assert.deepEqual(row['resize'], { cols: 110, rows: 37 })
      assert.equal(row['records'], 64)
      assert.equal(row['receiptCount'], 69)
      assert.ok(count(row['callbackBytes'], 1024 * 1024) > 0)
      assert.equal(row['callbackBytes'], row['consumedBytes'])
      assert.match(String(row['sha256']), /^[a-f0-9]{64}$/)
    } else {
      assert.deepEqual(row['controlledFailure'], {
        ok: false,
        code: row['name'] === 'cancelled' ? 'CANCELLED' : 'OVERLOADED',
      })
      assert.equal(row['stopCalls'], 1)
      assert.equal(row['childExitObserved'], true)
      assert.ok(Number.isSafeInteger(row['exitCode']) && row['exitCode'] !== 0)
      assert.ok(Number.isSafeInteger(row['terminalLifecycleCode']))
      assert.ok(
        row['signalCode'] === null ||
          typeof row['signalCode'] === 'string' ||
          Number.isSafeInteger(row['signalCode'])
      )
    }
  }
}
