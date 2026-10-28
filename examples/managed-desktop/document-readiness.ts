import type { ViewHandle } from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'

/** Fixture synchronization only. An RPC grant can precede native OnLoadEnd;
 * captureAuthority still performs the actual native policy validation afterward.
 * The caller owns the existing fixture deadline and must close this on failure.
 */
export function managedDocumentReadiness(backend: CefBackend, url: string) {
  let view: ViewHandle | undefined,
    document: string | undefined,
    done = false
  const early = new Set<string>()
  let removeNative = () => {},
    removeLifecycle = () => {},
    resolve!: () => void,
    reject!: (error: Error) => void
  const completion = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  void completion.catch(() => {})
  const finish = (error?: Error) => {
    if (done) return
    done = true
    early.clear()
    removeNative()
    removeLifecycle()
    if (error) reject(error)
    else resolve()
  }
  const ready = () => {
    if (!view || !document || !early.has(document)) return
    try {
      const state = backend.state(view)
      if (state.documentId !== document || state.url !== url || state.trust.kind !== 'application')
        throw new Error('MANAGED_DOCUMENT_CHANGED')
      finish()
    } catch (error) {
      finish(error instanceof Error ? error : new Error('MANAGED_DOCUMENT_CLOSED'))
    }
  }
  removeNative = backend.observe((event) => {
    if (event.event !== 'view.loaded' || event.data?.['url'] !== url) return
    const loaded = event.data['documentId']
    if (typeof loaded !== 'string' || !/^[a-z0-9-]{1,128}$/.test(loaded)) return
    if (document && loaded !== document) return
    if (!early.has(loaded) && early.size === 4) {
      finish(new Error('MANAGED_DOCUMENT_RECEIPT_CAPACITY'))
      return
    }
    early.add(loaded)
    ready()
  })
  removeLifecycle = backend.onEvent((event) => {
    if (event.resource !== view) return
    if (event.type === 'disposed') finish(new Error('MANAGED_DOCUMENT_CLOSED'))
    else if (
      event.type === 'navigated' &&
      (event.state.documentId !== document || event.state.url !== url)
    )
      finish(new Error('MANAGED_DOCUMENT_CHANGED'))
  })
  void backend.closed.then(
    () => finish(new Error('MANAGED_DOCUMENT_CLOSED')),
    (error: unknown) =>
      finish(error instanceof Error ? error : new Error('MANAGED_DOCUMENT_CLOSED'))
  )
  return {
    wait(created: ViewHandle): Promise<void> {
      if (view && view !== created) throw new Error('MANAGED_DOCUMENT_ALREADY_BOUND')
      if (!done && !view) {
        view = created
        try {
          const state = backend.state(created)
          if (state.url !== url || state.trust.kind !== 'application')
            throw new Error('MANAGED_DOCUMENT_CHANGED')
          document = state.documentId
          ready()
        } catch (error) {
          finish(error instanceof Error ? error : new Error('MANAGED_DOCUMENT_CLOSED'))
        }
      }
      return completion
    },
    close(error = new Error('MANAGED_DOCUMENT_CANCELLED')) {
      finish(error)
    },
  }
}
