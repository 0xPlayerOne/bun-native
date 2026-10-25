import { test, expect } from 'bun:test'
import { treeObservationGate } from '../examples/cef/fault-tree-notification.ts'
const nonce = 'a'.repeat(48),
  pids = [101, 102]
const receipt = { mode: 'backend-shell-tree-exit', nonce, pids }
const headers = { 'x-bunly-observation': nonce }
function request(path: string, body?: unknown, token = nonce) {
  return new Request('http://127.0.0.1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-bunly-observation': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
for (const early of [true, false]) {
  test(`tree observation notification is retained across waiter registration: early=${early}`, async () => {
    const gate = treeObservationGate(nonce, pids)
    let pending: Promise<Response>
    if (early) {
      expect((await gate(request('/observed', receipt))).status).toBe(204)
      pending = gate(request('/observation'))
    } else {
      pending = gate(request('/observation'))
      expect((await gate(request('/observed', receipt))).status).toBe(204)
    }
    expect((await pending).status).toBe(204)
    expect((await gate(request('/observed', receipt))).status).toBe(409)
    expect((await gate(request('/observation'))).status).toBe(409)
  })
}
test('tree notification rejects foreign, malformed, reordered and oversized receipts', async () => {
  const gate = treeObservationGate(nonce, pids)
  expect((await gate(request('/observed', receipt, 'b'.repeat(48)))).status).toBe(403)
  for (const body of [
    {},
    { ...receipt, pids: [102, 101] },
    { ...receipt, nonce: 'b'.repeat(48) },
    { ...receipt, extra: true },
    'x'.repeat(1025),
  ])
    expect((await gate(request('/observed', body))).status).toBe(400)
  expect((await gate(request('/unknown'))).status).toBe(404)
  expect((await gate(request('/observed', receipt))).status).toBe(204)
  expect((await gate(request('/observation'))).status).toBe(204)
})
test('actual descendant listener completes one pending HTTP notification without polling', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 1024,
    fetch: treeObservationGate(nonce, pids),
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1000)
  try {
    expect(await (await fetch(server.url)).text()).toBe('owned-native-fault-server')
    const waiting = fetch(new URL('/observation', server.url), {
      headers,
      signal: controller.signal,
    })
    const published = await fetch(new URL('/observed', server.url), {
      method: 'POST',
      headers,
      body: JSON.stringify(receipt),
      signal: controller.signal,
    })
    expect(published.status).toBe(204)
    expect((await waiting).status).toBe(204)
  } finally {
    clearTimeout(timer)
    controller.abort()
    server.stop(true)
  }
})
