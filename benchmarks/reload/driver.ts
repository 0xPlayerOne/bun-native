/** Finite synthetic mechanism probe. The outer maintained process observer owns this process. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { writeSync, openSync, closeSync, fstatSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join, resolve } from 'node:path'
import { candidate, bounded, ProbeDeadline, rebind } from './candidate.ts'
import {
  moduleSource,
  rejectedSources,
  reloadCandidates,
  reloadMemoryScope,
  type ReloadCandidate,
} from './fixtures.ts'

const mode = process.argv[2] as ReloadCandidate
const directory = resolve(process.argv[3]!)
const count = Number(process.argv[4])
const hang = process.argv[5] === 'hang'
assert.ok(reloadCandidates.includes(mode))
assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 100)
assert.equal(Bun.version, '1.4.4')
const stable = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => new Response('stable-owner'),
})
const source = join(directory, 'application.ts')
await writeFile(source, moduleSource, { flag: 'wx', mode: 0o600 })
await writeFile(join(directory, 'dependency.ts'), 'export const revision = 0\n', {
  flag: 'wx',
  mode: 0o600,
})
Bun.gc(true)
const heapBefore = process.memoryUsage().heapUsed
const trials: Record<string, unknown>[] = []
const failures: Record<string, unknown>[] = []
const report: Record<string, unknown> = {
  schema: 1,
  profile: 'reload-mechanisms-v1',
  mode,
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  complete: false,
  heapAfterInitialGcBytes: heapBefore,
  hang,
  samples: count,
  trials,
  failures,
  resourceScope: 'synthetic-loopback-listener-and-timer-not-native-CEF-or-PTY',
  memoryScope: reloadMemoryScope(mode),
}
try {
  if (hang && (mode === 'graph' || mode === 'import')) {
    const graph = mode === 'graph' ? new Bun.ModuleGraph() : undefined
    writeSync(
      1,
      JSON.stringify({ event: 'loop-entered', mode, stableListenerCreated: true }) + '\n'
    )
    const loop = () => {
      for (;;) {
        /* Parent-observed negative control. */
      }
    }
    if (graph) graph.run(loop)
    else loop()
  } else if (hang) {
    const session = candidate(mode, source, true)
    try {
      const ready = await bounded(session.ready)
      assert.equal(ready['event'], 'ready')
      assert.ok(session.loopEntered)
      await bounded(session.loopEntered)
      await session.stop()
      const attempts = await rebind(Number(ready['port']))
      assert.equal(await (await fetch(`http://127.0.0.1:${stable.port}`)).text(), 'stable-owner')
      report['hangResult'] = {
        loopEntryObserved: true,
        ownedGenerationStopped: true,
        stableOwnerSurvived: true,
        listenerRebindAttempts: attempts,
      }
    } finally {
      await session.stop()
    }
  } else {
    for (let iteration = 0; iteration < count; iteration++) {
      const dependency = `export const revision = ${iteration}\n`
      await writeFile(join(directory, 'dependency.ts'), dependency)
      const row: Record<string, unknown> = { iteration, expectedRevision: iteration, passed: false }
      trials.push(row)
      const started = performance.now()
      const session = candidate(mode, source)
      try {
        const ready = await bounded(session.ready)
        assert.equal(ready['event'], 'ready')
        row['loadMs'] = performance.now() - started
        row['revision'] = ready['revision']
        row['moduleInstance'] = ready['moduleInstance']
        row['globalInstance'] = ready['globalInstance']
        row['freshDependency'] = ready['revision'] === iteration
        row['freshModuleState'] = ready['moduleInstance'] === 1
        const port = Number(ready['port'])
        await Bun.sleep(20)
        const live = (await (await fetch(`http://127.0.0.1:${port}`)).json()) as {
          revision: number
          ticks: number
        }
        assert.equal(live.revision, ready['revision'])
        assert.ok(live.ticks > 0)
        const before = session.ticks?.()
        const stopStarted = performance.now()
        await session.stop()
        row['disposeRequestMs'] = performance.now() - stopStarted
        row['listenerRebindAttempts'] = await rebind(port)
        await Bun.sleep(20)
        row['timerStopped'] = before === undefined ? null : session.ticks!() === before
        row['cleanupEvidence'] =
          mode === 'worker'
            ? 'worker-exit-and-port-rebind'
            : mode === 'process'
              ? 'child-reaped-and-port-rebind'
              : 'timer-stable-and-port-rebind'
        row['stableOwnerSurvived'] =
          (await (await fetch(`http://127.0.0.1:${stable.port}`)).text()) === 'stable-owner'
        row['rssBytes'] = process.memoryUsage().rss
        row['heapUsedBytes'] = process.memoryUsage().heapUsed
        row['passed'] =
          row['stableOwnerSurvived'] === true &&
          (row['timerStopped'] === null || row['timerStopped'] === true)
        assert.equal(row['passed'], true)
      } finally {
        await session.stop()
      }
    }
    for (const [name, contents] of Object.entries(rejectedSources)) {
      const path = join(directory, `${name}.ts`)
      await writeFile(path, contents, { flag: 'wx', mode: 0o600 })
      const session = candidate(mode, path)
      let outcome = 'unexpected-success'
      try {
        const ready = await bounded(session.ready, name === 'pending' ? 300 : 2000)
        if (ready['event'] === 'rejected') outcome = 'rejected'
      } catch (error) {
        outcome = error instanceof ProbeDeadline ? 'bounded-pending' : 'unexpected-error'
      } finally {
        await session.stop()
      }
      assert.equal(await (await fetch(`http://127.0.0.1:${stable.port}`)).text(), 'stable-owner')
      failures.push({
        name,
        outcome,
        stableOwnerSurvived: true,
        incompleteImportPromise: name === 'pending' && (mode === 'graph' || mode === 'import'),
      })
      assert.equal(outcome, name === 'pending' ? 'bounded-pending' : 'rejected')
    }
  }
  if (!hang && mode === 'graph') {
    const asHost = AsyncLocalStorage.snapshot()
    const graph = new Bun.ModuleGraph()
    const bus = new EventTarget()
    let externalCalls = 0,
      microtasks = 0,
      pendingSettled = false
    let descriptor: number | undefined
    let stableGraphServer: ReturnType<typeof Bun.serve> | undefined
    let graphServer: ReturnType<typeof Bun.serve> | undefined
    const listener = () => {
      externalCalls++
    }
    try {
      graph.run(() => {
        bus.addEventListener('fixed-probe', listener)
        queueMicrotask(() => {
          microtasks++
        })
        void Bun.sleep(10).then(() => {
          pendingSettled = true
        })
        descriptor = openSync(source, 'r')
        graphServer = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch: () => new Response('graph'),
        })
        stableGraphServer = asHost(() =>
          Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('stable') })
        )
      })
      const graphPort = graphServer!.port!
      graph.dispose()
      await Bun.sleep(30)
      bus.dispatchEvent(new Event('fixed-probe'))
      const unmanagedFdSurvived = fstatSync(descriptor!).isFile()
      const hostContextResourceSurvived =
        (await (await fetch(`http://127.0.0.1:${stableGraphServer!.port}`)).text()) === 'stable'
      report['graphBoundary'] = {
        externalListenerCallsAfterDisposal: externalCalls,
        queuedMicrotasksAfterDisposal: microtasks,
        pendingSettledAfter30Ms: pendingSettled,
        unmanagedFdSurvived,
        hostContextResourceSurvived,
        graphListenerRebindAttempts: await rebind(graphPort),
      }
      assert.equal(externalCalls, 1)
      assert.equal(microtasks, 1)
      assert.equal(pendingSettled, false)
      assert.equal(unmanagedFdSurvived, true)
      assert.equal(hostContextResourceSurvived, true)
    } finally {
      bus.removeEventListener('fixed-probe', listener)
      if (descriptor !== undefined) closeSync(descriptor)
      graph.dispose()
      graphServer?.stop(true)
      stableGraphServer?.stop(true)
    }
    let caught: ((value: string) => void) | undefined
    const error = new Promise<string>((resolve) => {
      caught = resolve
    })
    const errorGraph = new Bun.ModuleGraph({ onError: (_error, kind) => caught!(kind) })
    try {
      errorGraph.run(() =>
        setTimeout(() => {
          throw Error('INTENTIONAL_ASYNC_FAILURE')
        }, 0)
      )
      report['graphAsyncErrorKind'] = await bounded(error)
      assert.equal(report['graphAsyncErrorKind'], 'uncaughtException')
    } finally {
      errorGraph.dispose()
    }
  }
  Bun.gc(true)
  report['heapAfterFinalGcBytes'] = process.memoryUsage().heapUsed
  report['complete'] = true
} catch (error) {
  report['failureType'] = error instanceof Error ? error.name : 'UnknownError'
  process.exitCode = 1
} finally {
  stable.stop(true)
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
  console.log(
    JSON.stringify({ event: 'reload-probe-complete', mode, complete: report['complete'] })
  )
}
