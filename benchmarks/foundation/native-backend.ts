import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { decodeNativeTitle, maxNativeTitleBytes } from './native-wire.ts'

/** Existing title events carry fixture measurements only; they grant no renderer authority. */
export default async function main(backend: CefBackend): Promise<void> {
  let finish!: (value: Record<string, unknown>) => void
  let fail!: (error: Error) => void
  let ready = false
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  void result.catch(() => {})
  const timer = setTimeout(() => fail(new Error('Native profiling page deadline')), 15000)
  const remove = backend.observe((event) => {
    if (event.event !== 'view.title') return
    const title = event.data?.['title']
    if (typeof title !== 'string' || !title.startsWith('bunly.foundation:')) return
    try {
      if (
        title.length > maxNativeTitleBytes ||
        new TextEncoder().encode(title).byteLength > maxNativeTitleBytes
      )
        throw new Error('Oversized profiling result')
      const value = JSON.parse(title.slice('bunly.foundation:'.length)) as Record<string, unknown>
      if (value['kind'] === 'ready') {
        if (ready) throw new Error('Duplicate readiness marker')
        ready = true
        console.error(JSON.stringify({ event: 'bunly.foundation.ready' }))
      } else if (value['kind'] === 'result' && ready) finish({ ...decodeNativeTitle(title) })
      else if (value['kind'] === 'failure') throw new Error(String(value['message']))
      else throw new Error('Unexpected profiling page state')
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
  try {
    const session = await backend.createSession({
      partition: 'foundation-profile',
      persistence: 'ephemeral',
    })
    const window = await backend.createWindow({
      title: 'Bunly foundation profile',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    })
    const view = await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    await backend.focusView(view)
    const measurement = await result
    console.error(
      JSON.stringify({
        event: 'bunly.foundation.result',
        measurement,
        diagnostics: await backend.nativeDiagnostics(),
      })
    )
  } finally {
    clearTimeout(timer)
    remove()
    await backend.dispose()
  }
}
