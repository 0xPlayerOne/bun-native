import type { ViewHandle } from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'

/** Require actual native OnLoadEnd for this exact remote document, including reload. */
export function remoteDocumentReadiness(backend: CefBackend, url: string, previous?: string) {
  let view: ViewHandle | undefined,
    expected: string | undefined,
    done = false,
    resolve!: (document: string) => void,
    reject!: (error: Error) => void
  const loaded = new Set<string>()
  const completion = new Promise<string>((yes, no) => {
    resolve = yes
    reject = no
  })
  void completion.catch(() => {})
  let removeNative = () => {},
    removeLifecycle = () => {}
  const finish = (error?: Error, document?: string) => {
    if (done) return
    done = true
    removeNative()
    removeLifecycle()
    loaded.clear()
    if (error) reject(error)
    else resolve(document!)
  }
  const check = () => {
    if (!view || !expected) return
    try {
      const state = backend.state(view)
      if (state.url === url && state.documentId === expected && loaded.has(expected)) {
        if (state.trust.kind !== 'remote')
          throw new Error('Fixture document acquired application trust')
        finish(undefined, state.documentId)
      }
    } catch (error) {
      finish(new Error(String(error)))
    }
  }
  removeNative = backend.observe((event) => {
    if (
      event.event === 'view.navigating' &&
      view &&
      previous &&
      !expected &&
      event.data?.['url'] === url
    ) {
      const state = backend.state(view)
      if (
        state.url === url &&
        state.documentId !== previous &&
        state.documentId === event.data['documentId']
      )
        expected = state.documentId
    }
    if (event.event !== 'view.loaded' || event.data?.['url'] !== url) return
    const document = event.data['documentId']
    if (
      typeof document !== 'string' ||
      !/^[a-z0-9-]{1,128}$/.test(document) ||
      event.data['status'] !== 200
    ) {
      finish(new Error('Invalid native fixture document receipt'))
      return
    }
    if (document === previous) return
    if (loaded.size >= 4 && !loaded.has(document)) {
      finish(new Error('Fixture readiness capacity exceeded'))
      return
    }
    loaded.add(document)
    check()
  })
  removeLifecycle = backend.onEvent((event) => {
    if (event.resource === view && event.type === 'disposed')
      finish(new Error('Fixture document closed before readiness'))
  })
  return {
    wait(created: ViewHandle) {
      if (view && view !== created) throw new Error('Fixture readiness already has an owner')
      view = created
      const state = backend.state(view)
      if (!expected && state.url === url && state.documentId !== previous)
        expected = state.documentId
      check()
      return completion
    },
    close: () => finish(new Error('Fixture readiness closed')),
  }
}
