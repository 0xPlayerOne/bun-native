import type { ViewHandle, ViewState } from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'

/** Fixture synchronization for an existing view's explicit navigation. The
 * native reply can precede or follow its document callbacks. This never grants
 * authority; the caller captures and grants a fresh policy scope afterward.
 */
export function dialogNavigationReadiness(backend: CefBackend, view: ViewHandle, url: string) {
  const previous = backend.state(view).documentId
  // This CEF-only fixture checks the pinned native diagnostic identity format
  // to reject another view's load receipt. It is not a policy authority token.
  const identity = /^native-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(previous)
  const target = Number(identity?.[1])
  if (identity?.[0] !== previous || !Number.isSafeInteger(target) || target < 1)
    throw new Error('MANAGED_DOCUMENT_CHANGED')
  const documentPattern = new RegExp(`^native-${target}-[1-9][0-9]*$`)
  let document: string | undefined,
    done = false,
    resolve!: () => void,
    reject!: (error: Error) => void,
    removeNative = () => {},
    removeLifecycle = () => {}
  const completion = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  void completion.catch(() => {})
  const finish = (error?: Error) => {
    if (done) return
    done = true
    removeNative()
    removeLifecycle()
    if (error) reject(error)
    else resolve()
  }
  const current = (state: ViewState) => {
    if (state.documentId === previous) return false
    if (
      state.url !== url ||
      state.trust.kind !== 'remote' ||
      documentPattern.exec(state.documentId)?.[0] !== state.documentId ||
      (document !== undefined && state.documentId !== document)
    ) {
      finish(new Error('MANAGED_DOCUMENT_CHANGED'))
      return false
    }
    document = state.documentId
    return true
  }
  removeLifecycle = backend.onEvent((event) => {
    if (event.resource !== view) return
    if (event.type === 'disposed') finish(new Error('MANAGED_DOCUMENT_CLOSED'))
    else if (event.type === 'navigated') current(event.state)
  })
  removeNative = backend.observe((event) => {
    if (event.target !== target || event.event !== 'view.loaded') return
    if (event.data?.['documentId'] === previous) return
    try {
      if (!current(backend.state(view)) || done) return
      const data = event.data
      if (!data || data['documentId'] !== document || data['url'] !== url || data['status'] !== 200)
        finish(new Error('MANAGED_DOCUMENT_CHANGED'))
      else finish()
    } catch (error) {
      finish(error instanceof Error ? error : new Error('MANAGED_DOCUMENT_CLOSED'))
    }
  })
  void backend.closed.then(
    () => finish(new Error('MANAGED_DOCUMENT_CLOSED')),
    (error: unknown) =>
      finish(error instanceof Error ? error : new Error('MANAGED_DOCUMENT_CLOSED'))
  )
  return {
    wait: () => completion,
    close: (error = new Error('MANAGED_DOCUMENT_CANCELLED')) => finish(error),
  }
}
