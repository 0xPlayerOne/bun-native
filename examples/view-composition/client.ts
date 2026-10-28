import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { compositionMarker, compositionSchema, panes, type Pane } from './contract.ts'

async function main(): Promise<void> {
  const pane = new URL(location.href).searchParams.get('pane') as Pane
  const draft = document.querySelector<HTMLInputElement>('#draft')
  const title = document.querySelector<HTMLElement>('#title')
  if (!panes.includes(pane) || !draft || !title) throw new Error('Invalid composition document')
  const instance = crypto.randomUUID()
  const marker = compositionMarker(pane)
  title.textContent = `Bunly ${pane}`
  document.documentElement.dataset['pane'] = pane
  draft.value = marker
  sessionStorage.setItem('bunly.composition', marker)
  const client = new RpcClient(compositionSchema, await waitForCefRpcTransport())
  let sequence = 0,
    previous = '',
    stopped = false
  let chain = Promise.resolve()
  const remove = () => {
    removeEventListener('resize', report)
    removeEventListener('focus', report)
    removeEventListener('blur', report)
    document.removeEventListener('visibilitychange', report)
  }
  const report = () => {
    if (stopped) return
    // Read state in the actual browser event callback, before queueing any RPC.
    const state = {
      pane,
      instance,
      width: innerWidth,
      height: innerHeight,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      form: draft.value,
      session: sessionStorage.getItem('bunly.composition') ?? '',
      devicePixelRatio,
    }
    const serialized = JSON.stringify(state)
    if (serialized === previous) return
    previous = serialized
    if (sequence === 128) throw new Error('Composition observation budget exceeded')
    const receipt = { ...state, sequence: sequence++ }
    chain = chain.then(async () => {
      if (stopped) return
      if ((await client.call('observe', receipt)).stop) {
        stopped = true
        remove()
      }
    })
    void chain.catch((error: unknown) => {
      stopped = true
      remove()
      console.error('Composition observation failed', error)
    })
  }
  addEventListener('resize', report)
  addEventListener('focus', report)
  addEventListener('blur', report)
  document.addEventListener('visibilitychange', report)
  addEventListener(
    'pagehide',
    () => {
      stopped = true
      remove()
      client.close()
    },
    { once: true }
  )
  report()
}
void main().catch((error: unknown) => console.error('Composition renderer failed', error))
