import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { DevSession, type RemountReport } from './session.ts'

function relevant(path: string | Buffer | null): boolean {
  if (path === null) return true
  const name = path.toString().replaceAll('\\', '/')
  if (
    name
      .split('/')
      .some((part) => ['node_modules', '.git', '.bun-native', 'dist', 'build'].includes(part))
  )
    return false
  return /\.[jt]sx?$|\.json$/.test(name)
}

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
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: number | undefined
  let running = true
  let closing = false
  const stop = () => {
    closing = true
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
      report(await session.reload(changedAt))
    } catch (error) {
      if (!closing) {
        console.error(error instanceof Error ? error.message : String(error))
        if (error instanceof AggregateError)
          for (const detail of error.errors) console.error(detail)
      }
    } finally {
      running = false
      if (!closing && pending !== undefined && timer === undefined) timer = setTimeout(pump, 50)
    }
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    watcher = watch(directory, { recursive: true }, (_event, filename) => {
      if (closing || !relevant(filename)) return
      pending = performance.now()
      clearTimeout(timer)
      timer = setTimeout(pump, 50)
    })
    // Store watcher failure as a value so an error during the initial build is
    // observed after it settles, without a detached rejected promise.
    watcher.on('error', failed.resolve)
    try {
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
    clearTimeout(timer)
    watcher?.close()
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    const teardown = await session.close()
    if (teardown) console.log('bun-native:stopped ' + JSON.stringify(teardown))
  }
}
