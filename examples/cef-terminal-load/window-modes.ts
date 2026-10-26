import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import type { WindowHandle } from '../../packages/contracts/src/index.ts'
import {
  expectedVisibility,
  matchesLoadMode,
  requireLoadMode,
  type LoadMode,
} from './mode-state.ts'

/** One coalesced native read per notification; no recurring poll or implicit retry.
 * A foreign event is only a hint: the supplied opaque handle selects the read. */
export async function awaitWindowMode(
  backend: Pick<CefBackend, 'observe' | 'windowState'>,
  window: WindowHandle,
  selected: LoadMode,
  visibility: () => 'visible' | 'hidden',
  action: () => Promise<unknown>,
  signal?: AbortSignal
) {
  let resolve!: (value: ReturnType<typeof requireLoadMode>) => void
  let reject!: (error: unknown) => void
  const result = new Promise<ReturnType<typeof requireLoadMode>>((yes, no) => {
    resolve = yes
    reject = no
  })
  void result.catch(() => {})
  const lifetime = new AbortController()
  let armed = false,
    active = false,
    pending = false,
    ended = false
  let remove = () => {}
  const finish = (error?: unknown, value?: ReturnType<typeof requireLoadMode>) => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    lifetime.abort(error ?? new Error('Window mode observation completed'))
    remove()
    signal?.removeEventListener('abort', abort)
    if (error !== undefined) reject(error)
    else resolve(value!)
  }
  const abort = () => finish(signal?.reason ?? new Error('Window mode cancelled'))
  const timer = setTimeout(() => finish(new Error('Native load window mode deadline')), 10000)
  const inspect = () => {
    if (!armed || ended) return
    pending = true
    if (active) return
    active = true
    void (async () => {
      try {
        while (pending && !ended) {
          pending = false
          const state = await backend.windowState(window, { signal: lifetime.signal })
          if (
            !ended &&
            matchesLoadMode(selected, state) &&
            visibility() === expectedVisibility(selected)
          )
            finish(undefined, requireLoadMode(selected, state, visibility()))
        }
      } catch (error) {
        finish(error)
      } finally {
        active = false
      }
    })()
  }
  try {
    remove = backend.observe((event) => {
      if (['window.state-changed', 'rpc.packet', 'window.closed'].includes(event.event)) inspect()
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    if (!ended) {
      await Promise.race([action(), result])
      armed = true
      inspect()
    }
    return await result
  } catch (error) {
    finish(error)
    throw error
  } finally {
    clearTimeout(timer)
    remove()
    signal?.removeEventListener('abort', abort)
  }
}
