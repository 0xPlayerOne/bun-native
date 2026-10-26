import { Terminal } from '@xterm/xterm'
import { TerminalRecords } from '../cef-terminal/terminal-records.ts'
import { TERMINAL_COLS, TERMINAL_ROWS } from '../cef-terminal/terminal-contract.ts'
import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { waitForCefStreamTransport } from '../../packages/client/src/cef-streams.ts'
import { BinaryStreamReceiver } from '../../packages/contracts/src/streams.ts'
import { StreamBudget } from '../../packages/contracts/src/stream-budget.ts'
import { BATCHES, LOAD, loadRecord } from './workload.ts'
import { schema, check } from './contract.ts'
const rpc = new RpcClient(schema, await waitForCefRpcTransport())
const visibility = () => (document.visibilityState === 'visible' ? 'visible' : 'hidden')
addEventListener('visibilitychange', () => {
  void rpc.call('visibility', visibility())
})
const parent = document.querySelector<HTMLElement>('#terminals')
check(parent)
const consumers = Array.from({ length: LOAD.terminals }, (_, index) => {
  const terminal = new Terminal({
    cols: TERMINAL_COLS,
    rows: TERMINAL_ROWS,
    scrollback: 512,
    allowProposedApi: true,
  })
  const element = document.createElement('section')
  parent.append(element)
  terminal.open(element)
  const screen = new TerminalRecords({
    maxRecords: BATCHES * (LOAD.recordsPerBatch + 1) + 1,
    retainedRecords: 600,
  })
  let chunks: Uint8Array[] = []
  let bytes = 0
  let consumerMs = 0
  let batch = 0
  let final = false
  let control: Promise<number> | undefined
  async function digest() {
    const joined = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.length
    }
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  }
  return {
    terminal,
    async consume(chunk: Uint8Array) {
      const start = performance.now()
      if (batch < BATCHES && !control) {
        const begin = performance.now()
        control = rpc.call('progress', batch).then((value) => {
          check(value === batch)
          return performance.now() - begin
        })
      }
      check(!final)
      await new Promise<void>((resolve) => terminal.write(chunk, resolve))
      consumerMs += performance.now() - start
      bytes += chunk.length
      check(bytes <= LOAD.maxBatchBytes && chunks.length < LOAD.maxCallbacksPerBatch)
      chunks.push(new Uint8Array(chunk))
      const added = screen.update(terminal.buffer.active)
      for (const record of added) {
        if (batch < BATCHES && record.sequence % (LOAD.recordsPerBatch + 1) < LOAD.recordsPerBatch)
          check(
            JSON.stringify(record.value) ===
              JSON.stringify(loadRecord(batch, record.sequence % (LOAD.recordsPerBatch + 1))),
            'Fixed displayed payload/order differs'
          )
        else if (batch < BATCHES) {
          check(
            JSON.stringify(record.value) ===
              JSON.stringify({ type: 'batch-complete', batch, tty: true })
          )
          check(screen.count === (batch + 1) * (LOAD.recordsPerBatch + 1) && screen.unicodeObserved)
          // Receipt RPC follows the actual graphical write callback. The next
          // batch also waits for stream ACK, so accounting cannot race pending bytes.
          await rpc.call('consumed', {
            terminal: index,
            batch,
            bytes,
            callbacks: chunks.length,
            consumerMs,
            controlMs: await control!,
            sha256: await digest(),
            records: LOAD.recordsPerBatch + 1,
            visibility: visibility(),
          })
          batch++
          chunks = []
          bytes = 0
          consumerMs = 0
          control = undefined
        } else {
          check(
            record.sequence === BATCHES * (LOAD.recordsPerBatch + 1) &&
              JSON.stringify(record.value) === JSON.stringify({ type: 'final', batches: BATCHES })
          )
          final = true
        }
      }
    },
    async finish() {
      check(final && batch === BATCHES)
      await rpc.call('finished', {
        terminal: index,
        records: screen.count - BATCHES * (LOAD.recordsPerBatch + 1),
        bytes,
        sha256: await digest(),
      })
    },
  }
})
const receiver = new BinaryStreamReceiver(
  await waitForCefStreamTransport(),
  { budget: new StreamBudget(), owner: {}, timeoutMs: 15_000 },
  Object.fromEntries(consumers.map((consumer, index) => [`load-${index}`, consumer]))
)
addEventListener(
  'pagehide',
  () => {
    receiver.close()
    rpc.close()
    for (const consumer of consumers) consumer.terminal.dispose()
  },
  { once: true }
)
await rpc.call('ready', visibility())
