import type { NativeEvent } from '../../packages/runtime/src/native-transport.ts'
import { nativeRpcCases } from '../../benchmarks/lib/cef-rpc-acceptance.ts'

interface Clock {
  set(callback: () => void, milliseconds: number): unknown
  clear(handle: unknown): void
}
const clock: Clock = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Native rejection receipts, not page assertions or a replacement for acceptance.
 * Subscribe before view creation and keep its hostile child alive until this
 * barrier completes. A JS onload is not delivery confirmation for CEF messages.
 */
export function nativeRpcProbeReadiness(
  observe: (listener: (event: NativeEvent) => void) => () => void,
  timeoutMs = 10000,
  timer: Clock = clock
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('Invalid native RPC probe deadline')
  const pending = new Set(nativeRpcCases)
  let done = false
  let waiting = false
  let scheduled = false
  let handle: unknown
  let remove = () => {}
  let resolve!: () => void
  let reject!: (error: Error) => void
  const completion = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  void completion.catch(() => {})
  function finish(error?: Error) {
    if (done) return
    done = true
    if (scheduled) timer.clear(handle)
    remove()
    if (error) reject(error)
    else resolve()
  }
  remove = observe((event) => {
    if (event.event !== 'rpc.qualification' || typeof event.data?.['case'] !== 'string') return
    pending.delete(event.data['case'])
    if (pending.size === 0) finish()
  })
  if (done) remove()
  return {
    wait(): Promise<void> {
      if (!done && !waiting) {
        waiting = true
        handle = timer.set(
          () => finish(new Error('Native RPC probes missing: ' + [...pending].sort().join(', '))),
          timeoutMs
        )
        scheduled = true
      }
      return completion
    },
    close() {
      finish(new Error('Native RPC probe readiness cancelled'))
    },
  }
}
