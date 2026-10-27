import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ownedChild } from '../lib/owned-child.ts'
import type { ProbeModule, ReloadCandidate } from './fixtures.ts'

export class ProbeDeadline extends Error {}
export async function bounded<T>(work: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_yes, no) => {
        timer = setTimeout(() => no(new ProbeDeadline('bounded probe deadline')), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
export interface CandidateSession {
  ready: Promise<Record<string, unknown>>
  loopEntered?: Promise<void>
  stop(): Promise<void>
  ticks?: () => number
}
export function candidate(mode: ReloadCandidate, path: string, hang = false): CandidateSession {
  const isolated = fileURLToPath(new URL('./isolated.ts', import.meta.url))
  if (mode === 'process') {
    const child = ownedChild(
      [process.execPath, isolated, path, hang ? 'hang' : 'normal'],
      process.cwd()
    )
    return {
      ready: child.wait((r) => r['event'] === 'ready' || r['event'] === 'rejected'),
      ...(hang
        ? { loopEntered: child.wait((r) => r['event'] === 'loop-entered').then(() => {}) }
        : {}),
      stop: () => child.close(),
    }
  }
  if (mode === 'worker') {
    const worker = new Worker(new URL('./isolated.ts', import.meta.url), {
      workerData: { path, hang },
    })
    let entered: (() => void) | undefined
    const loopEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const ready = new Promise<Record<string, unknown>>((yes, no) => {
      worker.once('error', no)
      worker.on('message', (value: Record<string, unknown>) => {
        if (value['event'] === 'ready' || value['event'] === 'rejected') yes(value)
        if (value['event'] === 'loop-entered') entered!()
      })
    })
    // The exit event is observed separately from merely requesting termination.
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()))
    let stopped: Promise<void> | undefined
    return {
      ready,
      ...(hang ? { loopEntered } : {}),
      stop: () =>
        (stopped ??= (async () => {
          await bounded(worker.terminate())
          await bounded(exited)
          worker.removeAllListeners()
        })()),
    }
  }
  const graph = mode === 'graph' ? new Bun.ModuleGraph() : undefined
  const specifier = pathToFileURL(path).href
  let loaded: ProbeModule | undefined
  let stopped = false
  const run = <T>(fn: () => T): T => (graph ? graph.run(fn) : fn())
  const ready = (async () => {
    try {
      loaded = await (graph
        ? graph.import<ProbeModule>(specifier)
        : (import(specifier) as Promise<ProbeModule>))
      if (stopped) return { event: 'rejected', errorType: 'RetiredBeforeReady' }
      const state = run(() => loaded!.inspect())
      const port = run(() => loaded!.open())
      return { event: 'ready', ...state, port }
    } catch (error) {
      return { event: 'rejected', errorType: error instanceof Error ? error.name : 'UnknownError' }
    }
  })()
  return {
    ready,
    ticks: () => loaded?.readTicks() ?? 0,
    async stop() {
      stopped = true
      if (graph) graph.dispose()
      else loaded?.stop()
    },
  }
}
export async function rebind(port: number): Promise<number> {
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535)
  for (let attempt = 1; attempt <= 40; attempt++) {
    let server: ReturnType<typeof Bun.serve>
    try {
      server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('rebound') })
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EADDRINUSE') throw error
      if (attempt === 40) throw new Error('Listener remained owned after cleanup deadline')
      await Bun.sleep(5)
      continue
    }
    try {
      assert.equal(
        await (
          await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1500) })
        ).text(),
        'rebound'
      )
      return attempt
    } finally {
      server.stop(true)
    }
  }
  throw new Error('Unreachable listener admission')
}
