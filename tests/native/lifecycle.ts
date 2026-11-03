import { NativeHost } from '@bun-native/runtime'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Explicit native integration entry point. Default unit tests never substitute
// a fake process for this target: CI supplies the host it just built.
const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to the built native host')
const host = await NativeHost.launch({ executable: resolve(executable) })
const events = host[Symbol.asyncIterator]()
const cycles = 5

try {
  await assert.rejects(host.send({ type: 'close', window_id: 1 }), /invalid_handle/)
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const window_id = cycle + 1
    const root_id = cycle * 3 + 1
    const text_id = root_id + 1
    const input_id = root_id + 2
    await host.send({
      type: 'open',
      window_id,
      root_id,
      title: 'Bun Native lifecycle',
      width: 560,
      height: 380,
    })
    await assert.rejects(
      host.send({ type: 'open', window_id, root_id, title: 'Duplicate', width: 560, height: 380 }),
      /invalid_handle/
    )
    await host.send({
      type: 'batch',
      window_id,
      base_revision: 0,
      operations: [
        { type: 'create', node_id: text_id, element: { kind: 'text', text: `Cycle ${cycle}` } },
        { type: 'create', node_id: input_id, element: { kind: 'input', value: '' } },
        { type: 'insert', parent_id: root_id, child_id: text_id, index: 0 },
        { type: 'insert', parent_id: root_id, child_id: input_id, index: 1 },
      ],
    })
    await assert.rejects(
      host.send({
        type: 'batch',
        window_id,
        base_revision: 0,
        operations: [{ type: 'delete', node_id: text_id }],
      }),
      /stale_revision/
    )
    await host.send({
      type: 'batch',
      window_id,
      base_revision: 1,
      operations: [
        { type: 'set', node_id: text_id, element: { kind: 'text', text: `Updated ${cycle}` } },
        {
          type: 'set',
          node_id: input_id,
          element: { kind: 'input', value: 'é🙂漢' },
          expected_input_revision: 0,
        },
      ],
    })
    await host.send({ type: 'close', window_id })
    let closed = false
    while (!closed) {
      const event = await events.next()
      assert(!event.done)
      assert.equal(event.value.window_id, window_id)
      closed = event.value.type === 'closed'
      if (!closed) assert(['focus', 'blur'].includes(event.value.type))
    }
    await assert.rejects(host.send({ type: 'close', window_id }), /invalid_handle/)
  }
} finally {
  await host.shutdown()
}

await host.shutdown()
assert.equal(await host.exited, 0)
if (process.env['BUN_NATIVE_STARTUP_TRACE'] === '1') {
  const path = process.env['BUN_NATIVE_EVIDENCE_LOG']
  const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
  assert(path && nonce)
  const evidence = readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      const value: unknown = JSON.parse(line)
      assert(value && typeof value === 'object' && !Array.isArray(value))
      const record = value as Record<string, unknown>
      assert.equal(record['nonce'], nonce)
      return record
    })
  const records = evidence.filter((record) => record['stage'] === 'startup-diagnostic')
  const opened = records.filter(
    (record) => record['source'] === 'transport' && record['response'] === 'opened'
  )
  assert.equal(opened.length, cycles)
  for (const response of opened) {
    const phases = records
      .filter(
        (record) => record['source'] === 'native' && record['request_id'] === response['request_id']
      )
      .map((record) => record['phase'])
    assert.deepEqual(phases, [
      'open_dispatched',
      'open_window_enter',
      'root_constructor_enter',
      'root_constructor_returned',
      'open_window_returned',
      'activation_returned',
      'opened_submit_returned',
    ])
  }
  assert(!records.some((record) => record['phase'] === 'record_limit'))
  assert(!records.some((record) => record['phase'] === 'transport_failed'))
  assert(
    records.some((record) => record['phase'] === 'transport_finished' && record['exit_code'] === 0)
  )
  if (process.env['BUN_NATIVE_STARTUP_LOG'] === '1') {
    const logs = evidence.filter((record) => record['stage'] === 'startup-log')
    assert.equal(logs[0]?.['phase'], 'logger_installed')
    assert(logs.length > 1 && logs.length <= 64)
    assert(!logs.some((record) => ['record_limit', 'byte_limit'].includes(String(record['phase']))))
    assert(
      logs.some(
        (record) =>
          record['target'] === 'gpui_linux::linux::x11::window' &&
          String(record['message']).startsWith('Using ')
      )
    )
    assert(
      logs.some(
        (record) =>
          record['target'] === 'gpui_wgpu::wgpu_context' &&
          String(record['message']).startsWith('Selected GPU (passed configuration test):')
      )
    )
  }
}
console.log(JSON.stringify({ status: 'passed', nativeWindowCycles: cycles, nativeExitCode: 0 }))
