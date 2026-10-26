import { Terminal } from '@xterm/xterm'
import { TerminalRecords } from '../cef-terminal/terminal-records.ts'
import { TERMINAL_COLS, TERMINAL_ROWS } from '../cef-terminal/terminal-contract.ts'
import type { RpcClient } from '../../packages/client/src/rpc.ts'
import { BATCHES, LOAD, loadRecord } from './workload.ts'
import { schema, check } from './contract.ts'
import { LatestDiagnostic, type ConsumerDiagnostic } from './diagnostics.ts'

export function loadConsumers(rpc: Pick<RpcClient<typeof schema>, 'call'>) {
  const visibility = () => (document.visibilityState === 'visible' ? 'visible' : 'hidden')
  const parent = document.querySelector<HTMLElement>('#terminals')
  check(parent)
  return Array.from({ length: LOAD.terminals }, (_, index) => {
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
    let controlState = 'idle'
    const reporter = new LatestDiagnostic((value) => rpc.call('diagnostic', value))
    function stage(value: ConsumerDiagnostic['stage'], error: unknown = null) {
      reporter.update({
        terminal: index,
        batch,
        stage: value,
        control: controlState,
        bytes,
        callbacks: chunks.length,
        records: screen.count,
        visibility: visibility(),
        error: error === null ? null : String(error).slice(0, 240),
      })
    }
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
        try {
          const start = performance.now()
          if (batch < BATCHES && !control) {
            const begin = performance.now()
            controlState = 'pending'
            control = rpc
              .call('progress', batch)
              .then((value) => {
                controlState = 'resolved'
                check(value === batch)
                return performance.now() - begin
              })
              .catch((error) => {
                controlState = 'failed'
                stage('error', error)
                throw error
              })
            void control.catch(() => {})
          }
          check(!final)
          stage('xterm-write')
          await new Promise<void>((resolve) => terminal.write(chunk, resolve))
          consumerMs += performance.now() - start
          bytes += chunk.length
          check(bytes <= LOAD.maxBatchBytes && chunks.length < LOAD.maxCallbacksPerBatch)
          chunks.push(new Uint8Array(chunk))
          stage('screen-parse')
          const added = screen.update(terminal.buffer.active)
          for (const record of added) {
            if (
              batch < BATCHES &&
              record.sequence % (LOAD.recordsPerBatch + 1) < LOAD.recordsPerBatch
            )
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
              check(
                screen.count === (batch + 1) * (LOAD.recordsPerBatch + 1) && screen.unicodeObserved
              )
              // Receipt RPC follows the actual graphical write callback. The next
              // batch also waits for stream ACK, so accounting cannot race pending bytes.
              stage('control-rpc')
              const controlMs = await control!
              stage('digest')
              const sha256 = await digest()
              stage('consumed-rpc')
              await rpc.call('consumed', {
                terminal: index,
                batch,
                bytes,
                callbacks: chunks.length,
                consumerMs,
                controlMs,
                sha256,
                records: LOAD.recordsPerBatch + 1,
                visibility: visibility(),
              })
              stage('ack-pending')
              batch++
              chunks = []
              bytes = 0
              consumerMs = 0
              control = undefined
              controlState = 'idle'
            } else {
              check(
                record.sequence === BATCHES * (LOAD.recordsPerBatch + 1) &&
                  JSON.stringify(record.value) ===
                    JSON.stringify({ type: 'final', batches: BATCHES })
              )
              final = true
            }
          }
          stage('consume-return')
        } catch (error) {
          stage('error', error)
          throw error
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
}
