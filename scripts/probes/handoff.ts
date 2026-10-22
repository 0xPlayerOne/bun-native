import { Worker } from 'node:worker_threads'
import assert from 'node:assert/strict'
import { loadNative } from './native-api.ts'
const [mode, path] = process.argv.slice(2)
if ((mode !== 'ffi' && mode !== 'napi') || !path)
  throw new Error('Expected binding mode and native library path')
const started = performance.now()
const api = loadNative(path, mode)
assert.equal(api.markMain(), 0)
const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { path, mode } })
let report: Record<string, unknown> | undefined
const completed = new Promise<void>((resolve, reject) => {
  worker.on('error', reject)
  worker.on('message', (message: Record<string, unknown>) => {
    if (message['released']) resolve()
    else {
      report = message
      worker.postMessage('release')
    }
  })
  worker.on('exit', (code) => {
    if (code !== 0) reject(new Error(`worker exit ${code}`))
  })
})
const status = api.run(10_000)
if (status !== 0) {
  await worker.terminate()
  api.close()
  throw new Error(`Native handoff returned ${status}`)
}
let timer: ReturnType<typeof setTimeout> | undefined
try {
  await Promise.race([
    completed,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Worker cleanup timed out')), 5000)
    }),
  ])
} finally {
  if (timer) clearTimeout(timer)
  await worker.terminate()
  api.close()
}
assert.equal(report?.['received'], 50)
assert.ok(Number(report?.['timerTicks']) > 0)
console.log(
  JSON.stringify({
    mode,
    passed: true,
    elapsedMs: performance.now() - started,
    rss: process.memoryUsage().rss,
    ...report,
  })
)
