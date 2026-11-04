import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { projectFingerprint, rescanInput } from './inputs.ts'
import { DevSession, type RemountReport } from './session.ts'

function report(value: RemountReport): void {
  console.log('bun-native:ready ' + JSON.stringify(value))
}

export async function watchProject(
  repository: string,
  directory: string,
  host: string
): Promise<void> {
  const session = new DevSession(repository, directory, host)
  const stopped = Promise.withResolvers<void>()
  const failed = Promise.withResolvers<Error>()
  const scanController = new AbortController()
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: number | undefined
  let snapshot = ''
  let scanning: Promise<string> | undefined
  let running = true
  let closing = false
  const stop = () => {
    closing = true
    scanController.abort()
    stopped.resolve()
    // close() marks cancellation synchronously before joining any active build.
    // Its rejection is also observed by the final cleanup below.
    void session.close().catch(() => {})
  }

  const pump = async () => {
    timer = undefined
    if (running || closing || pending === undefined) return
    const changedAt = pending
    pending = undefined
    running = true
    try {
      scanning = projectFingerprint(directory, scanController.signal)
      const next = await scanning
      scanning = undefined
      if (closing || next === snapshot) return
      // Record the attempted bytes before compiling. A rejected edit stays live
      // without a retry loop, and edits during the build remain pending.
      snapshot = next
      report(await session.reload(changedAt))
    } catch (error) {
      if (!closing) {
        console.error(error instanceof Error ? error.message : String(error))
        if (error instanceof AggregateError)
          for (const detail of error.errors) console.error(detail)
      }
    } finally {
      scanning = undefined
      running = false
      if (!closing && pending !== undefined && timer === undefined) timer = setTimeout(pump, 50)
    }
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    watcher = watch(directory, { recursive: true }, (_event, filename) => {
      if (closing || !rescanInput(filename)) return
      pending = performance.now()
      clearTimeout(timer)
      timer = setTimeout(pump, 50)
    })
    // Store watcher failure as a value so an error during the initial build is
    // observed after it settles, without a detached rejected promise.
    watcher.on('error', failed.resolve)
    try {
      // Observe first, then snapshot: events during initial scanning/building are
      // coalesced and checked against these bytes after the initial mount.
      snapshot = await projectFingerprint(directory, scanController.signal)
      report(await session.reload())
    } catch (error) {
      if (closing) return
      throw error
    }
    running = false
    if (pending !== undefined && timer === undefined) timer = setTimeout(pump, 50)
    console.log(
      'Watching project source. Each successful edit remounts the application and resets state.'
    )
    const exit = await Promise.race([session.exited, stopped.promise, failed.promise])
    if (exit instanceof Error) throw exit
    if (exit !== undefined && exit !== 0)
      throw new Error('Application exited without clean teardown')
  } finally {
    closing = true
    scanController.abort()
    clearTimeout(timer)
    watcher?.close()
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await scanning?.catch(() => {})
    const teardown = await session.close()
    if (teardown) console.log('bun-native:stopped ' + JSON.stringify(teardown))
  }
}
