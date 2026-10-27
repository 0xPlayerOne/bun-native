/** One disposable generation. The same file executes in Bun's worker or a Bun subprocess. */
import { parentPort, workerData } from 'node:worker_threads'
import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { ProbeModule } from './fixtures.ts'
const input = parentPort
  ? (workerData as { path: string; hang: boolean })
  : {
      path: process.argv[2]!,
      hang: process.argv[3] === 'hang',
    }
const send = (value: Record<string, unknown>) => {
  if (parentPort) parentPort.postMessage(value)
  else writeSync(1, JSON.stringify(value) + '\n')
}
try {
  const loaded = (await import(pathToFileURL(input.path).href)) as ProbeModule
  const state = loaded.inspect()
  const port = loaded.open()
  send({ event: 'ready', ...state, port })
  if (input.hang) {
    send({ event: 'loop-entered' })
    for (;;) {
      /* Deliberate bounded-parent negative fixture; never an application runtime path. */
    }
  }
} catch (error) {
  send({ event: 'rejected', errorType: error instanceof Error ? error.name : 'UnknownError' })
}
