import { Terminal } from '@xterm/xterm'
import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { waitForCefStreamTransport } from '../../packages/client/src/cef-streams.ts'
import { BinaryStreamReceiver } from '../../packages/contracts/src/streams.ts'
import { StreamBudget } from '../../packages/contracts/src/stream-budget.ts'
import {
  FORM_MARKER,
  LOGIN_MARKER,
  SESSION_MARKER,
  TOTAL_REPLACEMENTS,
  managedRpcLimits,
  managedSchema,
  type ManagedAction,
} from './contract.ts'
import { ManagedTerminalConsumer } from './terminal-consumer.ts'

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
// Do not hold module evaluation open: native transport grants follow OnLoadEnd.
async function main(): Promise<void> {
  const draft = document.querySelector<HTMLInputElement>('#draft')
  const output = document.querySelector<HTMLElement>('#terminal')
  const progress = document.querySelector<HTMLElement>('#progress')
  check(draft && output && progress, 'Missing fixture elements')
  draft.value = FORM_MARKER
  sessionStorage.setItem('bunly.managed.session', SESSION_MARKER)
  sessionStorage.setItem('bunly.managed.login', LOGIN_MARKER)
  const instance = crypto.randomUUID()
  const terminal = new Terminal({ cols: 100, rows: 24, scrollback: 100, allowProposedApi: true })
  terminal.open(output)
  const consumer = new ManagedTerminalConsumer(terminal)
  const finished = deferred<void>()
  let waiting: { revision: number; done: ReturnType<typeof deferred<void>> } | undefined
  const waitAck = (revision: number): Promise<void> => {
    if (consumer.lastAck === revision) return Promise.resolve()
    check(consumer.lastAck < revision && !waiting, 'Unexpected terminal acknowledgement ordering')
    const done = deferred<void>()
    waiting = { revision, done }
    return done.promise
  }
  const rpc = new RpcClient(managedSchema, await waitForCefRpcTransport(), {
    limits: managedRpcLimits,
  })
  const terminalFailed = (error: unknown): void => {
    const failure = error instanceof Error ? error : new Error('TERMINAL_CONSUMER_FAILED')
    finished.reject(failure)
    const code = /^TERMINAL_[A-Z_]{1,48}$/.test(failure.message)
      ? failure.message
      : 'TERMINAL_CONSUMER_FAILED'
    void rpc.call('fail', code).catch(() => {})
  }
  const receiver = new BinaryStreamReceiver(
    await waitForCefStreamTransport(),
    {
      budget: new StreamBudget(),
      owner: {},
      timeoutMs: 15_000,
    },
    {
      continuity: {
        async consume(chunk) {
          try {
            for (const record of await consumer.consume(chunk)) {
              if (record.kind === 'ack' && waiting?.revision === record.revision) {
                waiting.done.resolve()
                waiting = undefined
              }
            }
          } catch (error) {
            terminalFailed(error)
            throw error
          }
        },
        finish() {
          try {
            consumer.finish()
            finished.resolve()
          } catch (error) {
            terminalFailed(error)
            throw error
          }
        },
      },
    }
  )
  addEventListener(
    'pagehide',
    () => {
      rpc.close()
      receiver.close()
      terminal.dispose()
    },
    { once: true }
  )

  interface Readback {
    revision: number
    shared: number
    document: string
    url: string
    session: string
    terminal: string
    login: string
    frontend: number
    events: number
    state: string
  }
  let initial: Readback | undefined
  let frontend = 0
  let frontendHash = ''
  const stylesheet = new CSSStyleSheet()
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, stylesheet]
  const hotUpdate = async () => {
    const source: {
      version: number
      frontend: number
      shared: number
      css: string
      sha256: string
    } = JSON.parse(await rpc.call('frontend', null))
    check(source.css.length > 0 && source.css.length <= 8192, 'Invalid frontend source size')
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source.css)))
    )
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    check(digest === source.sha256, 'Hot stylesheet bytes changed in transport')
    await stylesheet.replace(source.css)
    const computed = getComputedStyle(document.documentElement)
    check(
      computed.getPropertyValue('--fixture-revision').trim() === String(source.frontend),
      'Updated frontend stylesheet was not applied'
    )
    check(
      computed.getPropertyValue('--managed-shared').trim() === String(source.shared),
      'Updated shared stylesheet was not applied'
    )
    frontend = source.version
    frontendHash = digest
  }
  const readback = async (revision: number) => {
    const result: Readback = JSON.parse(await rpc.call('readback', null))
    check(
      result.revision === revision && result.shared === (revision >= 250 ? 1 : 0),
      'Changed dependency was not served by the replacement'
    )
    check(result.frontend === frontend, 'Frontend notification was not observed')
    check(
      result.login === LOGIN_MARKER && result.state === '{"retained":"workspace"}',
      'Login or transferred state changed'
    )
    if (!initial) initial = result
    check(
      result.document === initial.document &&
        result.url === initial.url &&
        result.session === initial.session &&
        result.terminal === initial.terminal,
      'Native identity changed'
    )
    check(result.events > 0, 'Generation listener did not run')
    check(
      draft.value === FORM_MARKER &&
        sessionStorage.getItem('bunly.managed.session') === SESSION_MARKER &&
        sessionStorage.getItem('bunly.managed.login') === LOGIN_MARKER,
      'Browser state changed'
    )
    await waitAck(revision)
    const computed = getComputedStyle(document.documentElement)
    const frontendStyle = computed.getPropertyValue('--fixture-revision').trim()
    const sharedStyle = computed.getPropertyValue('--managed-shared').trim()
    check(
      /^[01]$/.test(frontendStyle) && /^[01]$/.test(sharedStyle),
      'Missing hot stylesheet state'
    )
    await rpc.call('verify', {
      revision,
      shared: result.shared,
      frontend,
      frontendHash,
      frontendStyle: Number(frontendStyle),
      sharedStyle: Number(sharedStyle),
      form: draft.value,
      session: sessionStorage.getItem('bunly.managed.session')!,
      login: sessionStorage.getItem('bunly.managed.login')!,
      instance,
      terminalSequence: consumer.lastSequence,
      terminalAck: consumer.lastAck,
    })
  }
  const step = async (action: ManagedAction, revision: number) =>
    JSON.parse(await rpc.call('step', { action, revision })) as { action: string; revision: number }
  try {
    await rpc.call('begin', null)
    await hotUpdate()
    await readback(0)
    for (let revision = 1; revision <= TOTAL_REPLACEMENTS; revision++) {
      const pending = revision === 375 ? rpc.call('pending', null) : undefined
      if (pending) void pending.catch(() => {})
      const result = await step('advance', revision)
      check(
        result.action === (revision === 250 ? 'both' : 'reloaded'),
        'Expected a successful actual replacement'
      )
      if (revision === 250) await hotUpdate()
      if (pending)
        check((await pending) === 'RETIRED', 'Pending request did not settle with retirement')
      await readback(revision)
      const failures: Partial<Record<number, ManagedAction>> = {
        100: 'syntax',
        200: 'import',
        300: 'initialization',
        425: 'closed-resource',
        450: 'runtime-handler',
      }
      const failure = failures[revision]
      if (failure) {
        check((await step(failure, revision)).action === 'failed', 'Expected injected failure')
        await readback(revision)
      }
      if (revision === 125) {
        check(
          (await step('frontend', revision)).action === 'frontend',
          'Frontend edit incorrectly replaced backend'
        )
        await hotUpdate()
        progress.dataset['frontendRevision'] = String(frontend)
        await readback(revision)
      }
      if (revision % 25 === 0)
        progress.textContent = `${revision} replacements; ${consumer.count} continuous terminal records; unsaved state retained.`
    }
    check(
      (await step('restart', TOTAL_REPLACEMENTS)).action === 'restart-required',
      'Sensitive configuration edit did not require restart'
    )
    await readback(TOTAL_REPLACEMENTS)
    await rpc.call('endTerminal', null)
    await finished.promise
    check(
      consumer.acks === TOTAL_REPLACEMENTS + 1 && consumer.lastAck === TOTAL_REPLACEMENTS,
      'Terminal acknowledgements incomplete'
    )
    await rpc.call('finish', {
      bytes: consumer.bytes,
      hash: consumer.hash,
      records: consumer.count,
      lastSequence: consumer.lastSequence,
      acks: consumer.acks,
    })
    progress.textContent = '500 replacements verified. Terminal output and browser state retained.'
  } catch (error) {
    waiting?.done.reject(error instanceof Error ? error : new Error('Renderer failure'))
    console.error('BUNLY_MANAGED_RENDERER_FAILED', error)
    await rpc.call('fail', 'RENDERER_ASSERTION').catch(() => {})
    throw error
  }
}
void main().catch((error) => console.error('BUNLY_MANAGED_RENDERER_STARTUP_FAILED', error))
