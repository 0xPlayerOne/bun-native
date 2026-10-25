import assert from 'node:assert/strict'
const mode = 'backend-shell-tree-exit'
export function validateTreeObservation(
  value: unknown,
  nonce: string,
  pids: readonly number[]
): void {
  assert.match(nonce, /^[a-f0-9]{48}$/)
  assert.equal(pids.length, 2)
  assert.equal(new Set(pids).size, 2)
  assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0 && pid < 2 ** 31))
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  const row = value as Record<string, unknown>
  assert.deepEqual(Object.keys(row).sort(), ['mode', 'nonce', 'pids'])
  assert.equal(row['mode'], mode)
  assert.equal(row['nonce'], nonce)
  assert.deepEqual(row['pids'], pids)
}

/** One retained notification on the already-owned descendant server. */
export function treeObservationGate(nonce: string, pids: readonly number[]) {
  validateTreeObservation({ mode, nonce, pids }, nonce, pids)
  const expected = [...pids]
  let complete!: () => void
  const observed = new Promise<void>((resolve) => {
    complete = resolve
  })
  let admitted = false,
    waiting = false,
    publishing = false
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (path === '/' && request.method === 'GET') return new Response('owned-native-fault-server')
    if (request.headers.get('x-bunly-observation') !== nonce)
      return new Response('Denied', { status: 403 })
    if (path === '/observation' && request.method === 'GET') {
      if (waiting) return new Response('Already waiting', { status: 409 })
      waiting = true
      await observed
      return new Response(null, { status: 204 })
    }
    if (path !== '/observed' || request.method !== 'POST')
      return new Response('Not found', { status: 404 })
    if (admitted || publishing) return new Response('Already observed', { status: 409 })
    publishing = true
    const reader = request.body?.getReader()
    if (!reader) {
      publishing = false
      return new Response('Missing receipt', { status: 400 })
    }
    try {
      const bytes = new Uint8Array(1024)
      let length = 0
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        if (part.value.byteLength > bytes.byteLength - length)
          throw new Error('Observation exceeds its bound')
        bytes.set(part.value, length)
        length += part.value.byteLength
      }
      validateTreeObservation(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))),
        nonce,
        expected
      )
      admitted = true
      complete()
      return new Response(null, { status: 204 })
    } catch {
      await reader.cancel().catch(() => {})
      return new Response('Invalid receipt', { status: 400 })
    } finally {
      publishing = false
      reader.releaseLock()
    }
  }
}
