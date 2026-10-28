import type { ViewHandle } from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import type { CefViewFocusState } from '../../packages/runtime/src/cef-view-focus-state.ts'

export type FocusPhase = 'sibling-closed' | 'sessions-closed' | 'window-shown' | 'cycle-created'
interface Clock {
  set(callback: () => void, milliseconds: number): unknown
  clear(handle: unknown): void
}
const clock: Clock = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
interface Observation {
  readonly event: 'bunly.native.focus'
  readonly phase: FocusPhase
  readonly stage: 'readiness' | 'focus' | 'complete'
  readonly state: CefViewFocusState | null
}

/** Wait for actual native eligibility, then request focus exactly once. The
 * interval only paces readback; elapsed time or renderer visibility never passes
 * this barrier. Native focus retains its own checks and any rejection is fatal.
 */
export async function focusWhenReady(
  backend: Pick<CefBackend, 'nativeViewFocusState' | 'focusView'>,
  view: ViewHandle,
  phase: FocusPhase,
  timeoutMs = 10000,
  timer: Clock = clock,
  report: (observation: Observation) => void = (value) => console.error(JSON.stringify(value))
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('Invalid native focus readiness deadline')
  const controller = new AbortController()
  const { signal } = controller
  let wake = () => {}
  let polling: unknown
  let state: CefViewFocusState | null = null
  let stage: 'readiness' | 'focus' = 'readiness'
  const deadline = timer.set(() => {
    controller.abort(new Error('Native focus readiness deadline: ' + phase))
    wake()
  }, timeoutMs)
  try {
    report({ event: 'bunly.native.focus', phase, stage, state })
    for (;;) {
      signal.throwIfAborted()
      state = await backend.nativeViewFocusState(view, { signal })
      signal.throwIfAborted()
      if (state.eligible) break
      await new Promise<void>((resolve) => {
        wake = resolve
        polling = timer.set(resolve, 16)
      })
      timer.clear(polling)
      polling = undefined
      wake = () => {}
    }
    stage = 'focus'
    await backend.focusView(view, { signal })
    signal.throwIfAborted()
    report({ event: 'bunly.native.focus', phase, stage: 'complete', state })
  } catch (cause) {
    report({ event: 'bunly.native.focus', phase, stage, state })
    throw new Error('Native focus fixture failed: ' + phase + '/' + stage, { cause })
  } finally {
    timer.clear(deadline)
    if (polling !== undefined) timer.clear(polling)
  }
}
