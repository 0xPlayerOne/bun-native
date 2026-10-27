import type { ServiceApplication } from '../../../packages/runtime/src/service-reload.ts'
import { revision } from './dependency.ts'
import { shared } from '../shared/value.ts'

const application: ServiceApplication = (context) => {
  const target = new EventTarget()
  let events = 0,
    ticks = 0
  const listener = () => {
    events++
  }
  const timer = setInterval(() => {
    ticks++
  }, 1)
  target.addEventListener('fixture', listener)
  // These assertions execute inside every retired real Worker before its cleanup receipt.
  context.own(async () => {
    clearInterval(timer)
    target.removeEventListener('fixture', listener)
    const before = { events, ticks }
    target.dispatchEvent(new Event('fixture'))
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
    if (events !== before.events || ticks !== before.ticks)
      throw new Error('Owned callback cleanup failed')
    let denied = false
    try {
      await context.invoke('probe', 'stale', JSON.stringify({ revision }))
    } catch {
      denied = true
    }
    if (!denied) throw new Error('Retired callback retained authority')
  })
  return {
    schema: 'managed-desktop:1',
    state: context.state ?? '{"retained":"workspace"}',
    handlers: {
      readback: async () => {
        target.dispatchEvent(new Event('fixture'))
        const view = JSON.parse(await context.invoke('view', 'state', 'null')) as {
          documentId: string
          url: string
        }
        const session = JSON.parse(await context.invoke('session', 'identity', 'null')) as {
          id: string
        }
        const cookies = JSON.parse(await context.invoke('session', 'cookies', 'null')) as {
          name: string
          value: string
        }[]
        const terminal = JSON.parse(await context.invoke('terminal', 'identity', 'null')) as {
          id: string
        }
        return JSON.stringify({
          revision,
          shared,
          document: view.documentId,
          url: view.url,
          session: session.id,
          terminal: terminal.id,
          login: cookies.find((cookie) => cookie.name === 'bunly_managed_login')?.value,
          events,
          ticks,
          state: context.state,
        })
      },
      emit: async (input) => {
        const requested: unknown = JSON.parse(input)
        if (requested !== revision) throw new Error('Wrong generation received terminal command')
        await context.invoke('terminal', 'write', JSON.stringify({ text: `ack:${revision}\n` }))
        return 'null'
      },
      pending: async (_input, request) => {
        await context.invoke('probe', 'pending', 'null')
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10_000)
          const abort = () => {
            clearTimeout(timer)
            request.signal.removeEventListener('abort', abort)
            resolve()
          }
          request.signal.addEventListener('abort', abort, { once: true })
          if (request.signal.aborted) abort()
        })
        // A late continuation from the cancelled request must be rejected by the broker.
        let denied = false
        try {
          await context.invoke('probe', 'stale', JSON.stringify({ revision }))
        } catch {
          denied = true
        }
        if (!denied) throw new Error('Cancelled continuation retained authority')
        return JSON.stringify({ lateRevision: revision })
      },
      runtimeFailure: () => {
        throw new Error('Fixed managed handler failure')
      },
    },
  }
}
export default application
