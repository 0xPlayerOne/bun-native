export type FairWorkPriority = 'bulk' | 'control'

export interface FairWorkSchedulerOptions {
  readonly maxWorkPerTurn?: number
  readonly maxQueuedWork?: number
  readonly reservedControlWork?: number
}

export interface FairWorkHandle {
  readonly pending: boolean
  cancel(): boolean
}

interface WorkItem {
  readonly owner: object
  readonly priority: FairWorkPriority
  readonly run: () => void
  readonly onCancel: (() => void) | undefined
  readonly onYield: (() => void) | undefined
  readonly enqueuedAt: number
  queue: OwnerQueue | undefined
  cancelled: boolean
  started: boolean
  accounted: boolean
}

interface OwnerQueue {
  readonly owner: object
  readonly items: WorkItem[]
  ready: boolean
}

const DEFAULTS = Object.freeze({
  maxWorkPerTurn: 16,
  maxQueuedWork: 256,
  reservedControlWork: 16,
})

function now(): number {
  return performance.now()
}

/**
 * One bounded, notification-driven work queue shared by related streams.
 * Owners rotate before their next item is considered, so one owner with many
 * streams cannot consume a whole turn. This schedules handoffs; it cannot
 * preempt a synchronous callback that never returns.
 */
export class FairWorkScheduler {
  readonly #maxWorkPerTurn: number
  readonly #maxQueuedWork: number
  readonly #reservedControlWork: number
  readonly #owners = new Map<object, OwnerQueue>()
  readonly #ready: OwnerQueue[] = []
  #queued = 0
  #bulkQueued = 0
  #controlQueued = 0
  #maxQueueDepth = 0
  #enqueued = 0
  #dispatched = 0
  #cancelled = 0
  #rejected = 0
  #yieldCount = 0
  #maxWaitMs = 0
  #lastWaitMs = 0
  #workThisTurn = 0
  #scheduled = false
  #yieldTask: ReturnType<typeof setImmediate> | undefined
  readonly #waitingForYield = new Set<WorkItem>()

  constructor(options: FairWorkSchedulerOptions = {}) {
    for (const key of Object.keys(options))
      if (!Object.hasOwn(DEFAULTS, key)) throw new TypeError('Unknown fair scheduler option')
    const maxWorkPerTurn = options.maxWorkPerTurn ?? DEFAULTS.maxWorkPerTurn
    const maxQueuedWork = options.maxQueuedWork ?? DEFAULTS.maxQueuedWork
    const reservedControlWork = options.reservedControlWork ?? DEFAULTS.reservedControlWork
    if (
      !Number.isSafeInteger(maxWorkPerTurn) ||
      maxWorkPerTurn < 1 ||
      maxWorkPerTurn > 1024 ||
      !Number.isSafeInteger(maxQueuedWork) ||
      maxQueuedWork < 1 ||
      maxQueuedWork > 4096 ||
      !Number.isSafeInteger(reservedControlWork) ||
      reservedControlWork < 0 ||
      reservedControlWork >= maxQueuedWork
    )
      throw new TypeError('Invalid fair scheduler bounds')
    this.#maxWorkPerTurn = maxWorkPerTurn
    this.#maxQueuedWork = maxQueuedWork
    this.#reservedControlWork = reservedControlWork
  }

  /** Admit work without buffering beyond the configured queue. */
  schedule(
    owner: object,
    run: () => void,
    options: {
      readonly priority?: FairWorkPriority
      readonly onCancel?: () => void
      readonly onYield?: () => void
    } = {}
  ): FairWorkHandle | undefined {
    if (!owner || typeof owner !== 'object' || typeof run !== 'function')
      throw new TypeError('Fair work requires an object owner and callback')
    const priority = options.priority ?? 'bulk'
    if (priority !== 'bulk' && priority !== 'control')
      throw new TypeError('Invalid fair work priority')
    if (
      this.#queued >= this.#maxQueuedWork ||
      (priority === 'bulk' && this.#queued >= this.#maxQueuedWork - this.#reservedControlWork)
    ) {
      this.#rejected++
      return undefined
    }
    let queue = this.#owners.get(owner)
    if (!queue) {
      queue = { owner, items: [], ready: false }
      this.#owners.set(owner, queue)
    }
    const item: WorkItem = {
      owner,
      priority,
      run,
      onCancel: options.onCancel,
      onYield: options.onYield,
      enqueuedAt: now(),
      queue,
      cancelled: false,
      started: false,
      accounted: true,
    }
    queue.items.push(item)
    if (!queue.ready) {
      queue.ready = true
      this.#ready.push(queue)
    }
    this.#queued++
    if (priority === 'bulk') this.#bulkQueued++
    else this.#controlQueued++
    this.#maxQueueDepth = Math.max(this.#maxQueueDepth, this.#queued)
    this.#enqueued++
    if (this.#workThisTurn >= this.#maxWorkPerTurn && item.onYield) this.#waitingForYield.add(item)
    this.#ensureScheduled()
    return {
      get pending() {
        return !item.cancelled && !item.started
      },
      cancel: () => this.#cancel(item),
    }
  }

  #cancel(item: WorkItem): boolean {
    if (item.cancelled || item.started) return false
    item.cancelled = true
    this.#account(item)
    this.#cancelled++
    this.#waitingForYield.delete(item)
    const queue = item.queue
    if (queue) {
      const index = queue.items.indexOf(item)
      if (index >= 0) queue.items.splice(index, 1)
      if (!queue.items.length && queue.ready) {
        queue.ready = false
        this.#owners.delete(queue.owner)
        const readyIndex = this.#ready.indexOf(queue)
        if (readyIndex >= 0) this.#ready.splice(readyIndex, 1)
      }
    }
    try {
      item.onCancel?.()
    } catch {
      // Cancellation must still release scheduler ownership.
    }
    if (!this.#queued) {
      if (this.#yieldTask !== undefined) clearImmediate(this.#yieldTask)
      this.#yieldTask = undefined
      this.#scheduled = false
    }
    return true
  }

  #account(item: WorkItem): void {
    if (!item.accounted) return
    item.accounted = false
    this.#queued--
    if (item.priority === 'bulk') this.#bulkQueued--
    else this.#controlQueued--
  }

  #ensureScheduled(): void {
    if (this.#scheduled || !this.#queued) return
    this.#scheduled = true
    if (this.#workThisTurn >= this.#maxWorkPerTurn) {
      this.#yieldTask = setImmediate(() => {
        this.#yieldTask = undefined
        this.#yieldCount++
        for (const item of this.#waitingForYield) item.onYield?.()
        this.#waitingForYield.clear()
        this.#workThisTurn = 0
        this.#scheduled = false
        this.#pump()
      })
    } else {
      queueMicrotask(() => {
        this.#scheduled = false
        this.#pump()
      })
    }
  }

  #next(): WorkItem | undefined {
    while (this.#ready.length) {
      const queue = this.#ready.shift()!
      let item: WorkItem | undefined
      while (queue.items.length) {
        const candidate = queue.items.shift()!
        if (!candidate.cancelled) {
          item = candidate
          break
        }
      }
      if (queue.items.length) this.#ready.push(queue)
      else {
        queue.ready = false
        this.#owners.delete(queue.owner)
      }
      if (item) return item
    }
    return undefined
  }

  #pump(): void {
    while (this.#queued && this.#workThisTurn < this.#maxWorkPerTurn) {
      const item = this.#next()
      if (!item) break
      item.started = true
      this.#account(item)
      this.#dispatched++
      this.#lastWaitMs = Math.max(0, now() - item.enqueuedAt)
      this.#maxWaitMs = Math.max(this.#maxWaitMs, this.#lastWaitMs)
      try {
        item.run()
      } catch {
        // The owner callback owns its failure path; a bad item cannot stop peers.
      }
      this.#workThisTurn++
    }
    this.#ensureScheduled()
  }

  diagnostics() {
    return Object.freeze({
      queueDepth: this.#queued,
      bulkQueued: this.#bulkQueued,
      controlQueued: this.#controlQueued,
      owners: Array.from(this.#owners.values()).filter((queue) => queue.items.length).length,
      maxQueueDepth: this.#maxQueueDepth,
      enqueued: this.#enqueued,
      dispatched: this.#dispatched,
      cancelled: this.#cancelled,
      rejected: this.#rejected,
      yields: this.#yieldCount,
      maxWaitMs: this.#maxWaitMs,
      lastWaitMs: this.#lastWaitMs,
      maxWorkPerTurn: this.#maxWorkPerTurn,
      maxQueuedWork: this.#maxQueuedWork,
      reservedControlWork: this.#reservedControlWork,
      coalesced: 0,
      dropped: 0,
      yieldPending: this.#yieldTask !== undefined,
    })
  }
}
