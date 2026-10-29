import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { hardwareCases } from './cases.ts'
import {
  parseWorkbenchCommand,
  workbenchSchema,
  type WorkbenchCommand,
  type WorkbenchSnapshot,
} from './contract.ts'

async function main(): Promise<void> {
  const status = document.querySelector<HTMLElement>('#connection')!
  const overlay = document.documentElement.dataset['surface'] === 'overlay'
  const client = new RpcClient(workbenchSchema, await waitForCefRpcTransport())
  let stopped = false,
    busy = false,
    reading = false,
    paused = false
  let displayedEvent = -1
  let timer: ReturnType<typeof setTimeout> | undefined
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const message = (value: string) => {
    if (status.textContent !== value) status.textContent = value
  }
  const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message.slice(0, 180) : 'Operation failed'

  function render(snapshot: WorkbenchSnapshot): void {
    const target = document.querySelector<HTMLElement>('#native-observation')
    if (target)
      target.textContent = JSON.stringify(
        {
          phase: snapshot.phase,
          backendHeartbeat: snapshot.heartbeat,
          observedAtMs: snapshot.observedAtMs,
          window: snapshot.window,
          panes: snapshot.panes,
          overlay: snapshot.overlay,
        },
        null,
        2
      )
    const events = document.querySelector<HTMLOListElement>('#native-events')
    const latestEvent = snapshot.events.at(-1)?.sequence ?? 0
    if (events && latestEvent !== displayedEvent) {
      displayedEvent = latestEvent
      const fragment = document.createDocumentFragment()
      for (const item of snapshot.events) {
        const line = document.createElement('li')
        line.textContent = `${item.sequence} · ${(item.elapsedMs / 1000).toFixed(1)}s · ${item.message}`
        fragment.append(line)
      }
      events.replaceChildren(fragment)
      document.querySelector<HTMLElement>('#event-budget')!.textContent =
        `Last ${snapshot.events.length} observations; ${snapshot.discardedEvents} older observations discarded. This is a bounded live view, not retained qualification evidence.`
    }
  }
  async function refresh(): Promise<void> {
    if (stopped || busy || reading) return
    reading = true
    try {
      render(await client.call('snapshot', null))
      if (
        status.textContent === 'Connecting to native application…' ||
        status.dataset['retry'] === 'true'
      ) {
        message('Connected. Manual hardware cases remain not run.')
        status.dataset['retry'] = 'false'
      }
    } catch (error) {
      message(`Observation unavailable: ${errorMessage(error)}`)
      status.dataset['retry'] = 'true'
    } finally {
      reading = false
    }
  }
  async function send(input: WorkbenchCommand): Promise<void> {
    if (stopped || busy) {
      message('A command is already pending. Try again after it settles.')
      return
    }
    busy = true
    // Snapshot reads are bounded; do not queue unbounded pointer/range commands behind them.
    const command = parseWorkbenchCommand(input)
    message(
      command.action === 'quit' ? 'Closing the final window…' : `Requesting ${command.action}…`
    )
    try {
      await client.call('command', command, { timeoutMs: 60_000 })
      message('Native command acknowledged. Observe the actual desktop behavior.')
    } catch (error) {
      message(`Command unavailable: ${errorMessage(error)}`)
    } finally {
      busy = false
    }
    await refresh()
  }

  if (overlay) {
    document.querySelector('#dismiss-overlay')!.addEventListener('click', () => {
      void send({ action: 'dismiss-overlay' })
    })
  } else {
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-command]')) {
      button.addEventListener('click', () => {
        void send(parseWorkbenchCommand(JSON.parse(button.dataset['command']!)))
      })
    }
    for (const form of document.querySelectorAll<HTMLFormElement>('form[data-pane]')) {
      const apply = () => {
        const values = new FormData(form)
        const command = parseWorkbenchCommand({
          action: 'present',
          pane: form.dataset['pane'],
          visible: values.get('visible') === 'on',
          focusable: values.get('focusable') === 'on',
          clip: values.get('clip'),
          width: Number(values.get('width')),
          height: Number(values.get('height')),
        })
        void send(command)
      }
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        apply()
      })
      let pending: ReturnType<typeof setTimeout> | undefined
      for (const range of form.querySelectorAll<HTMLInputElement>('input[type=range]')) {
        range.addEventListener('input', () => {
          form.querySelector<HTMLOutputElement>(`output[for="${range.id}"]`)!.value = range.value
          if (pending) return
          pending = setTimeout(() => {
            timers.delete(pending!)
            pending = undefined
            if (!stopped) apply()
          }, 160)
          timers.add(pending)
        })
      }
    }
    document.querySelector('#quit-question')!.addEventListener('click', () => {
      document.querySelector<HTMLElement>('#quit-confirmation')!.hidden = false
      document.querySelector<HTMLButtonElement>('#quit-confirm')!.focus()
    })
    document.querySelector('#quit-cancel')!.addEventListener('click', () => {
      document.querySelector<HTMLElement>('#quit-confirmation')!.hidden = true
      document.querySelector<HTMLButtonElement>('#quit-question')!.focus()
    })
    document.querySelector('#quit-confirm')!.addEventListener('click', () => {
      void send({ action: 'quit' })
    })
    const pause = document.querySelector<HTMLButtonElement>('#pause-observations')!
    pause.addEventListener('click', () => {
      paused = !paused
      pause.setAttribute('aria-pressed', String(paused))
      pause.textContent = paused ? 'Resume periodic observations' : 'Pause periodic observations'
    })
    document.querySelector('#refresh-observations')!.addEventListener('click', () => {
      void refresh()
    })
    const list = document.querySelector<HTMLOListElement>('#case-coverage')!
    for (const item of hardwareCases) {
      const row = document.createElement('li')
      const title = document.createElement('strong')
      title.textContent = `${item.id} — ${item.title}: ${item.status}`
      const explanation = document.createElement('p')
      explanation.textContent = item.coverage
      row.append(title, explanation)
      list.append(row)
    }
  }
  const poll = async () => {
    if (!paused) await refresh()
    if (!stopped)
      timer = setTimeout(() => {
        void poll()
      }, 1500)
  }
  addEventListener(
    'pagehide',
    () => {
      stopped = true
      clearTimeout(timer)
      for (const pending of timers) clearTimeout(pending)
      timers.clear()
      client.close()
    },
    { once: true }
  )
  await poll()
}
void main().catch(() => {
  document.querySelector<HTMLElement>('#connection')!.textContent =
    'Native bridge unavailable. Open this document only in the explicitly prepared native workbench.'
})
