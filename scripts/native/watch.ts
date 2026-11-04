import { createHash } from 'node:crypto'
import { createReadStream, watch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FSWatcher } from 'node:fs'
import { DevSession, type RemountReport } from './session.ts'

const ignoredDirectories = new Set(['node_modules', '.git', '.bun-native', 'dist', 'build'])

function relevant(path: string | Buffer | null | undefined): boolean {
  // Bun can omit a filename at runtime; both absent forms require a rescan.
  if (path === null || path === undefined) return true
  const name = path.toString().replaceAll('\\', '/')
  if (name.split('/').some((part) => ignoredDirectories.has(part))) return false
  return /\.[jt]sx?$|\.json$/.test(name)
}

// Notifications identify possible changes, not changed source. Anonymous events
// and duplicate delivery must not reset a live app when its inputs are identical.
async function sourceFingerprint(directory: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (path: string, prefix: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (ignoredDirectories.has(entry.name)) continue
      const filename = join(path, entry.name)
      const relative = prefix + entry.name
      if (entry.isDirectory()) await visit(filename, relative + '/')
      else if (relevant(entry.name)) {
        if (!entry.isFile() && !(entry.isSymbolicLink() && (await stat(filename)).isFile()))
          continue
        const content = createHash('sha256')
        for await (const chunk of createReadStream(filename)) content.update(chunk)
        hash.update(JSON.stringify([relative, content.digest('hex')]))
      }
    }
  }
  await visit(directory, '')
  return hash.digest('hex')
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
  let observedSource: string | undefined
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
      const source = await sourceFingerprint(directory)
      if (closing || source === observedSource) return
      // A failed compile is still an observed edit: duplicate notifications must
      // not retry it. A subsequent content change schedules another attempt.
      observedSource = source
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
      // Capture before building. Events during either operation stay pending, so
      // edits made while the initial app is compiling are not silently consumed.
      observedSource = await sourceFingerprint(directory)
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
