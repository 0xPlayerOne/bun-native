import assert from 'node:assert/strict'
import { pageTimeout } from './page-readiness.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
export default async function development(backend: CefBackend): Promise<void> {
  const origin = process.env['BUNLY_TEST_ORIGIN']
  const denied = process.env['BUNLY_TEST_DENIED_ORIGIN']
  if (!origin || !denied) throw new Error('Explicit private development fixture origins required')
  const session = await backend.createSession({
    partition: 'development-test',
    persistence: 'ephemeral',
  })
  const window = await backend.createWindow({
    title: 'Bunly local origin qualification',
    bounds: { x: 10, y: 10, width: 700, height: 500 },
  })
  let yes!: () => void, no!: (error: Error) => void
  const loaded = new Promise<void>((ok, bad) => {
    yes = ok
    no = bad
  })
  void loaded.catch(() => {})
  const listener = backend.observe((event) => {
    if (event.event !== 'view.console') return
    const text = String(event.data?.['message'])
    if (text === 'DEV_TEST_OK') yes()
    else if (text.startsWith('DEV_TEST_FAILED:')) no(new Error(text))
  })
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const view = await backend.createView({
      window,
      session,
      url: origin + '/',
      trust: { kind: 'remote' },
    })
    deadline = setTimeout(
      () => no(new Error('Development page did not complete')),
      process.env['BUNLY_TEST_PAGE_TIMEOUT_MS'] === undefined
        ? 12000
        : pageTimeout(process.env['BUNLY_TEST_PAGE_TIMEOUT_MS'])
    )
    await loaded
    const next = await backend.navigate(view, origin + '/allowed-redirect')
    assert.equal(next.url, origin + '/next')
    await assert.rejects(backend.navigate(view, denied + '/main'))
    await assert.rejects(backend.navigate(view, origin + '/denied-redirect'))
    const recovery = await backend.navigate(view, origin + '/next')
    assert.equal(recovery.url, origin + '/next')
    console.error(JSON.stringify({ event: 'bunly.native.development', passed: true }))
  } finally {
    if (deadline) clearTimeout(deadline)
    listener()
    await backend.dispose()
  }
}
