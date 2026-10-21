import type { NativeEvent } from '../../packages/runtime/src/native-transport.ts'

interface Clock {
  set(callback: () => void, milliseconds: number): unknown
  clear(handle: unknown): void
}
const clock: Clock = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Private fixture timing only; this never changes native-runtime RPC/startup deadlines. */
export function pageTimeout(value: string | undefined): number {
  if (value === undefined) return 10000
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('Invalid packaged-page deadline')
  const milliseconds = Number(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 60000)
    throw new Error('Invalid packaged-page deadline')
  return milliseconds
}

/** Subscribe before creation, but start the page's deadline after its view exists. */
export function packagedPageReadiness(
  observe: (listener: (event: NativeEvent) => void) => () => void,
  timeoutMs = 10000,
  timer: Clock = clock
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('Invalid packaged-page deadline')
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
    if (event.event !== 'view.console') return
    const message = event.data?.['message']
    if (typeof message !== 'string') return
    if (message.startsWith('BUNLY_ASSET_TEST_FAILED')) finish(new Error(message))
    else if (message === 'BUNLY_ASSET_TEST_OK') finish()
  })
  // An observer implementation may deliver a queued event synchronously.
  if (done) remove()
  return {
    wait(): Promise<void> {
      if (!done && !waiting) {
        waiting = true
        handle = timer.set(() => finish(new Error('Packaged module did not complete')), timeoutMs)
        scheduled = true
      }
      return completion
    },
    close() {
      finish(new Error('Packaged-page readiness cancelled'))
    },
  }
}
