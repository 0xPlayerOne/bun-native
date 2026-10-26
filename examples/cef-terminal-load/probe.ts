import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { LOAD } from './workload.ts'
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
export async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Load operation deadline')), 15_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
export class Probe {
  hash = createHash('sha256')
  bytes = 0
  callbacks = 0
  firstCallbackMs = 0
  pendingBytePeak = 0
  written = 0
  acknowledged = 0
  streamCallbacks = 0
  pending: Promise<void> = Promise.resolve()
  reset() {
    this.hash = createHash('sha256')
    this.bytes = 0
    this.callbacks = 0
    this.firstCallbackMs = 0
    this.pendingBytePeak = 0
    this.written = 0
    this.acknowledged = 0
    this.streamCallbacks = 0
    this.pending = Promise.resolve()
  }
  add(chunk: Uint8Array) {
    if (this.callbacks === 0) this.firstCallbackMs = performance.now()
    this.bytes += chunk.length
    this.pendingBytePeak = Math.max(this.pendingBytePeak, this.bytes - this.acknowledged)
    this.callbacks++
    assert.ok(this.bytes <= LOAD.maxBatchBytes && this.callbacks <= LOAD.maxCallbacksPerBatch)
    this.hash.update(chunk)
  }
}
