import { stat } from 'node:fs/promises'

/** Metadata change detection, not a content-integrity or untrusted-filesystem check. */
export async function dependencyStamp(path: string): Promise<string | null> {
  try {
    const value = await stat(path, { bigint: true })
    return [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].join(':')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

interface ReconciliationOptions {
  readonly maxEntries: number
  readonly intervalMs?: number
  readonly readStamp?: (path: string) => Promise<string | null>
  readonly changed: (paths: readonly string[]) => Promise<void>
  readonly failed: () => void
}

/** One non-overlapping, eight-read scan; never recursively walks a source tree. */
export class DependencyReconciler {
  readonly #options: ReconciliationOptions
  readonly #interval: number
  #entries = new Map<string, string | null>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #running: Promise<void> | undefined
  #closed = false

  constructor(options: ReconciliationOptions) {
    const interval = options.intervalMs ?? 1000
    if (
      !Number.isSafeInteger(options.maxEntries) ||
      options.maxEntries < 1 ||
      options.maxEntries > 16384 ||
      !Number.isSafeInteger(interval) ||
      interval < 1 ||
      interval > 10000
    )
      throw new RangeError('Invalid dependency reconciliation bounds')
    this.#options = options
    this.#interval = interval
  }

  replace(entries: ReadonlyMap<string, string | null>): void {
    if (this.#closed) return
    if (entries.size > this.#options.maxEntries)
      throw new RangeError('Dependency reconciliation capacity exceeded')
    this.#entries = new Map(entries)
    if (entries.size === 0 && this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#schedule()
  }

  #schedule(): void {
    if (this.#closed || this.#timer || this.#running || this.#entries.size === 0) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.scan()
    }, this.#interval)
    this.#timer.unref()
  }

  /** Coalesces manual/test scans with the timer; no concurrent scan can be admitted. */
  scan(): Promise<void> {
    if (this.#running) return this.#running
    if (this.#closed) return Promise.resolve()
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    // Defer entry so #running is installed even if an injected reader rejects synchronously.
    const running = Promise.resolve()
      .then(() => this.#scan())
      .catch(() => {
        if (this.#closed) return
        this.#closed = true
        this.#entries.clear()
        try {
          this.#options.failed()
        } catch {
          /* observer only */
        }
      })
      .finally(() => {
        this.#running = undefined
        this.#schedule()
      })
    this.#running = running
    return running
  }

  async #scan(): Promise<void> {
    const entries = this.#entries
    const work = [...entries.entries()]
    const changed: string[] = []
    const readStamp = this.#options.readStamp ?? dependencyStamp
    let next = 0
    let failure: unknown
    let failed = false
    const read = async () => {
      while (!this.#closed && this.#entries === entries && !failed) {
        const item = work[next++]
        if (!item) return
        try {
          const stamp = await readStamp(item[0])
          if (this.#closed || this.#entries !== entries) return
          if (stamp !== item[1]) {
            entries.set(item[0], stamp)
            changed.push(item[0])
          }
        } catch (error) {
          failure = error
          failed = true
        }
      }
    }
    // Drain all admitted reads before failure/close can report settled ownership.
    await Promise.all(Array.from({ length: Math.min(8, work.length) }, read))
    if (this.#closed || this.#entries !== entries) return
    if (failed) throw failure
    if (changed.length) await this.#options.changed(changed)
  }

  diagnostics(): Readonly<{
    trackedFiles: number
    scheduled: boolean
    running: boolean
    closed: boolean
  }> {
    return Object.freeze({
      trackedFiles: this.#entries.size,
      scheduled: this.#timer !== undefined,
      running: this.#running !== undefined,
      closed: this.#closed,
    })
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#entries.clear()
    await this.#running
  }
}
