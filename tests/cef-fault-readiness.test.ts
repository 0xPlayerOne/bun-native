/** Synthetic fixture-wiring regressions; actual process faults qualify separately. */
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import fault from '../examples/cef/fault.ts'
import type { CefBackend } from '../packages/runtime/src/cef.ts'
import type { NativeEvent } from '../packages/runtime/src/native-transport.ts'

async function withFaultMode(run: () => Promise<void>) {
  const previous = process.env['BUNLY_CEF_FAULT']
  process.env['BUNLY_CEF_FAULT'] = 'renderer-exit'
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env['BUNLY_CEF_FAULT']
    else process.env['BUNLY_CEF_FAULT'] = previous
  }
}
test('fault fixture provisions RPC before resource setup and retires it if setup fails', async () => {
  await withFaultMode(async () => {
    const order: string[] = []
    const backend = {
      serveRpc() {
        order.push('rpc')
        return () => {
          order.push('stop')
        }
      },
      async createSession() {
        order.push('session')
        throw new Error('controlled startup failure')
      },
    } as unknown as CefBackend
    await assert.rejects(fault(backend), /controlled startup failure/)
    assert.deepEqual(order, ['rpc', 'session', 'stop'])
  })
})
test('fault page failure remains fatal and retires its observer, RPC service and backend', async () => {
  await withFaultMode(async () => {
    const order: string[] = []
    let listener: ((event: NativeEvent) => void) | undefined
    let configured = false
    const backend = {
      serveRpc() {
        configured = true
        order.push('rpc')
        return () => {
          order.push('stop')
        }
      },
      async createSession() {
        return {}
      },
      async createWindow() {
        return {}
      },
      observe(fn: (event: NativeEvent) => void) {
        listener = fn
        return () => {
          listener = undefined
          order.push('off')
        }
      },
      async createView() {
        assert.equal(
          configured,
          true,
          'The RPC-dependent asset module needs a live server before view creation'
        )
        listener?.({
          v: 1,
          event: 'view.console',
          data: { message: 'BUNLY_ASSET_TEST_FAILED: controlled asset error' },
        })
        return {}
      },
      async dispose() {
        order.push('dispose')
      },
    } as unknown as CefBackend
    await assert.rejects(fault(backend), /BUNLY_ASSET_TEST_FAILED/)
    assert.equal(listener, undefined)
    assert.deepEqual(order, ['rpc', 'off', 'dispose', 'stop'])
  })
})
