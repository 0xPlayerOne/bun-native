import { Terminal } from '@xterm/xterm'
import {
  TerminalRecords,
  verifyFixedRecordPayloads,
  type ParsedRecord,
} from './terminal-records.ts'
import { beginTerminalNegativeControl } from './negative-control.ts'
import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { waitForCefStreamTransport } from '../../packages/client/src/cef-streams.ts'
import { BinaryStreamReceiver } from '../../packages/contracts/src/streams.ts'
import { StreamBudget } from '../../packages/contracts/src/stream-budget.ts'
import {
  RESIZED_COLS,
  RESIZED_ROWS,
  TERMINAL_COLS,
  TERMINAL_COUNT,
  TERMINAL_RECORDS,
  TERMINAL_ROWS,
  terminalRpcLimits,
  terminalSchema,
  type TerminalAction,
  type TerminalRecordReceipt,
} from './terminal-contract.ts'

const role = new URL(location.href).searchParams.get('role') ?? 'main'
const encoder = new TextEncoder()
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
  return { promise, resolve, reject }
}

class GraphicalConsumer {
  readonly terminal = new Terminal({
    cols: TERMINAL_COLS,
    rows: TERMINAL_ROWS,
    scrollback: 512,
    allowProposedApi: true,
  })
  readonly screen = new TerminalRecords()
  readonly records = this.screen.records
  readonly finished = deferred<void>()
  readonly callbackDurationsMs: number[] = []
  readonly chunks: Uint8Array[] = []
  readonly waiters: {
    readonly type: string
    readonly predicate: (record: ParsedRecord) => boolean
    readonly deferred: ReturnType<typeof deferred<ParsedRecord>>
  }[] = []
  readonly held = deferred<void>()
  readonly released = deferred<void>()
  bytes = 0
  callbacks = 0
  holdNext = false
  constructor(
    readonly index: number,
    parent: HTMLElement
  ) {
    const element = document.createElement('section')
    element.dataset['terminal'] = String(index)
    parent.append(element)
    this.terminal.open(element)
  }
  async consume(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
    const begin = performance.now()
    if (this.holdNext) {
      this.holdNext = false
      this.held.resolve()
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener('abort', abort)
          reject(new Error('Document stream aborted'))
        }
        signal.addEventListener('abort', abort, { once: true })
        void this.released.promise.then(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        })
        if (signal.aborted) abort()
      })
    }
    await new Promise<void>((resolve) => this.terminal.write(chunk, resolve))
    this.callbacks++
    this.bytes += chunk.byteLength
    if (this.bytes > 2 * 1024 * 1024 || this.callbacks > 4096)
      throw new Error('Fixture observation exceeded its bound')
    this.chunks.push(new Uint8Array(chunk))
    this.callbackDurationsMs.push(performance.now() - begin)
    for (const record of this.screen.update(this.terminal.buffer.active)) {
      for (let index = this.waiters.length - 1; index >= 0; index--) {
        const waiter = this.waiters[index]!
        if (waiter.type !== String(record.value['type']) || !waiter.predicate(record)) continue
        this.waiters.splice(index, 1)
        waiter.deferred.resolve(record)
      }
    }
  }
  wait(
    type: string,
    predicate: (record: ParsedRecord) => boolean = () => true
  ): Promise<ParsedRecord> {
    const existing = this.records.find(
      (record) => record.value['type'] === type && predicate(record)
    )
    if (existing) return Promise.resolve(existing)
    const waiting = deferred<ParsedRecord>()
    this.waiters.push({ type, predicate, deferred: waiting })
    return waiting.promise
  }
  async receipt(): Promise<TerminalRecordReceipt> {
    const bytes = new Uint8Array(this.bytes)
    let offset = 0
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
    return Object.freeze({
      terminal: this.index,
      records: this.records.length,
      bytes: this.bytes,
      sha256,
      order: Object.freeze(this.records.map((record) => record.sequence)),
      callbacks: this.callbacks,
      callbackDurationsMs: Object.freeze([...this.callbackDurationsMs]),
      unicodeObserved: this.screen.unicodeObserved,
      recordContentsVerified: verifyFixedRecordPayloads(this.records, TERMINAL_RECORDS),
    })
  }
  dispose(): void {
    this.terminal.dispose()
  }
}

const parent = document.querySelector<HTMLElement>('#terminals')
check(parent, 'Missing terminal host')
const count = role === 'main' ? TERMINAL_COUNT : 1
const consumers = Array.from({ length: count }, (_, index) => new GraphicalConsumer(index, parent))
const names = Object.fromEntries(
  consumers.map((consumer) => [
    role === 'main' ? `terminal-${consumer.index}` : `${role}-0`,
    {
      consume: (chunk: Uint8Array, context: { signal: AbortSignal }) =>
        consumer.consume(chunk, context.signal),
      finish: () => consumer.finished.resolve(),
    },
  ])
)
const receiver = new BinaryStreamReceiver(
  await waitForCefStreamTransport(),
  { budget: new StreamBudget(), owner: {}, timeoutMs: 15_000 },
  names
)
const rpc = new RpcClient(terminalSchema, await waitForCefRpcTransport(), {
  limits: terminalRpcLimits,
})
addEventListener(
  'pagehide',
  () => {
    rpc.close()
    receiver.close()
    for (const consumer of consumers) consumer.dispose()
  },
  { once: true }
)

const controlDurations: number[] = []
const control = async (terminal: number, action: TerminalAction, value = '-') => {
  const begin = performance.now()
  await rpc.call('control', { terminal, action, value })
  controlDurations.push(performance.now() - begin)
}

try {
  if (role === 'main') {
    const begin = performance.now()
    await Promise.all(consumers.map((consumer) => consumer.wait('ready')))
    check(
      consumers.every((consumer) => consumer.records[0]?.value['tty'] === true),
      'PTY missing'
    )

    const input = btoa(String.fromCharCode(...encoder.encode('fixed input café-🐙')))
    await control(1, 'input', input)
    check(
      (await consumers[1]!.wait('input')).value['value'] === 'fixed input café-🐙',
      'Input mismatch'
    )
    consumers[1]!.terminal.resize(RESIZED_COLS, RESIZED_ROWS)
    await control(1, 'resize')
    check((await consumers[1]!.wait('resize')).value['cols'] === RESIZED_COLS, 'Resize columns')
    check((await consumers[1]!.wait('resize')).value['rows'] === RESIZED_ROWS, 'Resize rows')
    await control(0, 'binary')
    await consumers[0]!.wait('binary-complete')

    consumers[0]!.holdNext = true
    await control(0, 'stall')
    await consumers[0]!.held.promise
    check((await rpc.call('gate', { name: 'consumer-0', action: 'held' })) === 'held', 'Gate hold')
    const rpcWhileHeld = (await rpc.call('progress', null)) === 'progress'
    await control(1, 'input', btoa('sibling-progress'))
    const siblingWhileHeld =
      (await consumers[1]!.wait('input', (record) => record.value['value'] === 'sibling-progress'))
        .value['value'] === 'sibling-progress'
    check(
      (await rpc.call('gate', { name: 'consumer-0', action: 'release' })) === 'release',
      'Gate release'
    )
    consumers[0]!.released.resolve()
    await consumers[0]!.wait('stall')

    for (let terminal = 0; terminal < TERMINAL_COUNT; terminal++) {
      await control(terminal, 'emit', String(TERMINAL_RECORDS))
      check(
        (await consumers[terminal]!.wait('emit-complete')).value['count'] === TERMINAL_RECORDS,
        'Record count'
      )
    }
    for (let terminal = 0; terminal < TERMINAL_COUNT; terminal++) await control(terminal, 'exit')
    await Promise.all(consumers.map((consumer) => consumer.wait('final')))
    await Promise.all(consumers.map((consumer) => consumer.finished.promise))
    const report = {
      terminals: await Promise.all(consumers.map((consumer) => consumer.receipt())),
      controlRoundtripsMs: controlDurations,
      heldConsumer: true,
      rpcWhileHeld,
      siblingWhileHeld,
      parserCallbacks: consumers.every((consumer) => consumer.callbacks > 0),
      totalElapsedMs: performance.now() - begin,
    }
    await rpc.call('report', report)
    console.log('BUNLY_TERMINAL_MAIN_COMPLETE')
  } else if (role === 'navigate' || role === 'overload') {
    await consumers[0]!.wait('ready')
    await beginTerminalNegativeControl(role, {
      arm: () => {
        consumers[0]!.holdNext = true
      },
      control: (action) => control(0, action),
      held: consumers[0]!.held.promise,
      pending: () =>
        console.log(
          role === 'navigate'
            ? 'BUNLY_TERMINAL_NAVIGATION_PENDING'
            : 'BUNLY_TERMINAL_OVERLOAD_PENDING'
        ),
    })
  } else throw new Error('Unknown terminal fixture role')
} catch (error) {
  console.error(`BUNLY_TERMINAL_FAILED:${error instanceof Error ? error.message : String(error)}`)
}
