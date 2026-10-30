import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { compositionMarker, compositionSchema, panes, type Pane } from './contract.ts'
import {
  interactionSchema,
  type InitialObservationCollector,
  type InitialObservationCommand,
  type InitialObservationPhase,
} from './initial-observation.ts'
import { COMPOSITION_INTERACTION_WORKLOAD_MS } from './interactions-plan.ts'

async function main(): Promise<void> {
  const pane = new URL(location.href).searchParams.get('pane') as Pane
  const draft = document.querySelector<HTMLInputElement>('#draft')
  const title = document.querySelector<HTMLElement>('#title')
  if (!panes.includes(pane) || !draft || !title) throw new Error('Invalid composition document')
  const interaction = new URL(location.href).searchParams.get('interaction') === '2'
  const initial = (
    globalThis as typeof globalThis & {
      __bunlyCompositionInitialObservation?: InitialObservationCollector
    }
  ).__bunlyCompositionInitialObservation
  if (interaction && !initial) throw new Error('Initial composition observer did not run')
  const instance = interaction ? initial!.instance : crypto.randomUUID()
  const marker = compositionMarker(pane)
  title.textContent = `Bunly ${pane}`
  document.documentElement.dataset['pane'] = pane
  draft.value = marker
  sessionStorage.setItem('bunly.composition', marker)
  // The ordinary composition wire schema and receipt remain unchanged.
  const client = new RpcClient(
    interaction ? interactionSchema : compositionSchema,
    await waitForCefRpcTransport()
  )
  if (interaction) {
    const observations = client as RpcClient<typeof interactionSchema>
    const recordInitial = async () => {
      let phase: InitialObservationPhase = 'initial'
      for (;;) {
        const command: { next: InitialObservationCommand } = await observations.call(
          'initialObservation',
          initial!.snapshot(phase),
          {
            timeoutMs: COMPOSITION_INTERACTION_WORKLOAD_MS,
          }
        )
        if (command.next === 'stop') return
        phase = command.next
      }
    }
    void recordInitial().catch((error: unknown) => {
      initial!.stop()
      console.error('Initial composition observation failed', error)
    })
  }
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
      initial?.stop()
      client.close()
    },
    { once: true }
  )
  report()
}
void main().catch((error: unknown) => console.error('Composition renderer failed', error))
