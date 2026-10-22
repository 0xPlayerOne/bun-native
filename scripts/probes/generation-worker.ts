import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { loadNative } from './native-api.ts'
interface Input {
  path: string
  mode: 'ffi' | 'napi'
  generation: number
  fault: 'none' | 'callback' | 'idle-timeout' | 'pre-register-exit' | 'hang'
}
const { path, mode, generation, fault } = workerData as Input
if (!parentPort) throw new Error('Worker-only fixture')
if (fault === 'pre-register-exit') process.exit(23)
const port = parentPort
const api = loadNative(path, mode)
assert.equal(api.run(1), -5, 'Worker must not own the native loop')
const offset = generation * 1024
const rounds = 256
const delays: number[] = []
let received = 0
let gcCycles = 0
let ticks = 0
let sent = 0
let timer: ReturnType<typeof setInterval> | undefined
let delay: ReturnType<typeof setTimeout> | undefined
let finished = false
function report(error?: unknown): void {
  if (finished) return
  finished = true
  if (timer) clearInterval(timer)
  if (delay) clearTimeout(delay)
  port.postMessage({
    type: 'result',
    generation,
    received,
    gcCycles,
    ticks,
    delays,
    error: error instanceof Error ? error.message : error === undefined ? null : String(error),
  })
  assert.equal(api.stop(), 0)
}
function send(): void {
  sent = performance.now()
  assert.equal(api.post(offset + received), 0)
}
assert.equal(
  api.setCallback((value) => {
    try {
      assert.equal(value, offset + received, 'Stale or out-of-order generation event')
      assert.equal(api.add(40, 2), 42, 'Native call from callback is reentrant-safe')
      assert.equal(api.run(1), -5)
      delays.push(performance.now() - sent)
      received++
      if (fault === 'callback' && received === 8) throw new Error('INJECTED_CALLBACK_FAILURE')
      if (received === rounds) {
        report()
        return
      }
      if (received % 16 === 0) {
        const bytes = Uint8Array.from({ length: 16384 }, (_, i) => i & 255)
        let hash = 2166136261
        for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0
        Bun.gc(true)
        gcCycles++
        assert.equal(api.checksum(bytes), hash)
        delay = setTimeout(send, 1)
      } else send()
    } catch (error) {
      report(error)
    }
  }),
  0
)
assert.equal(
  api.setCallback(() => {
    throw new Error('Duplicate callback was installed')
  }),
  -2
)
port.on('message', (message: unknown) => {
  if (message === 'run') {
    if (fault === 'idle-timeout') return
    if (fault === 'hang') {
      for (;;) {
        /* Isolated watchdog test, never application code. */
      }
    }
    // A native fd write bypasses the blocked parent's JS message queue.
    writeSync(1, JSON.stringify({ event: 'phase', phase: 'idle', generation }) + '\n')
    delay = setTimeout(() => {
      writeSync(1, JSON.stringify({ event: 'phase', phase: 'work', generation }) + '\n')
      timer = setInterval(() => {
        ticks++
      }, 2)
      send()
    }, 200)
  } else if (message === 'release') {
    if (timer) clearInterval(timer)
    if (delay) clearTimeout(delay)
    assert.equal(api.clearCallback(), 0)
    api.close()
    port.postMessage({ type: 'released', generation })
    port.close()
  }
})
port.postMessage({ type: 'ready', generation })
