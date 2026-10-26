import { StreamBudget } from '../../contracts/src/stream-budget.ts'
import type { BinaryStreamWriter, StreamOutcome } from '../../contracts/src/streams.ts'
import { StreamError, type StreamErrorCode } from '../../contracts/src/stream-wire.ts'
import { FairWorkScheduler, type FairWorkHandle } from './fair-scheduler.ts'

// Read intrinsic typed-array slots, not producer-overridable accessors/species.
const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')!.get!
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!

// A ready writer can replenish a source through a continuous microtask chain.
// A supplied shared scheduler bounds total work across its sources; standalone
// sources each use an independent scheduler.
const DRAIN_CHUNKS_PER_TURN = 16

export interface StreamSourceOptions {
  /** One shared pool and stable owner across sources/reconnects, never packet-provided. */
  readonly budget: StreamBudget
  readonly owner: object
  /** Must stop only this owned producer. The adapter is responsible for actual process cleanup. */
  readonly stopSource: (code: StreamErrorCode) => void
  readonly signal?: AbortSignal
  readonly maxChunkBytes?: number
  readonly maxRetainedBytes?: number
  readonly maxQueuedChunks?: number
  /** Lossless byte streams only: append to an unsent block, never delay its delivery. */
  readonly coalescePending?: boolean
  /** Shared bounded owner scheduler. A service passes its scheduler to share work. */
  readonly scheduler?: FairWorkScheduler
}
interface SourceChunk {
  readonly bytes: Uint8Array
  readonly capacity: number
  length: number
}
/** Bounded callback-source bridge. Not native view authorization or a PTY supervisor.
 * A push-only producer with no pause API fails explicitly on overload; it cannot
 * silently drop bytes, accumulate promises, or pretend transport handoff is consumption.
 */
export class CallbackStreamSource {
  readonly #queue: SourceChunk[] = []
  readonly #chunk: number
  readonly #capacity: number
  readonly #frames: number
  readonly #coalesce: boolean
  readonly #owner: object
  readonly #scheduler: FairWorkScheduler
  readonly #releaseReservation: () => void
  readonly #stopSource: (code: StreamErrorCode) => void
  readonly #writer: BinaryStreamWriter
  #removeAbort = () => {}
  #retained = 0
  #allocated = 0
  #peakAllocated = 0
  #coalescedBytes = 0
  #peak = 0
  #active = false
  #scheduled: FairWorkHandle | undefined
  #yieldCount = 0
  #ended = false
  #settled = false
  #released = false
  #reason: StreamErrorCode | undefined
  #sourceStopFailed = false
  #acknowledgedBytes = 0
  readonly finished: Promise<StreamOutcome>
  /** Resolves when THIS source's retained chunks/reservation are released, not proof of OS exit. */
  readonly drained: Promise<void>
  readonly #resolveFinished: (outcome: StreamOutcome) => void
  readonly #resolveDrained: () => void

  constructor(writer: BinaryStreamWriter, options: StreamSourceOptions) {
    this.#chunk = options.maxChunkBytes ?? 16 * 1024
    this.#capacity = options.maxRetainedBytes ?? 256 * 1024
    this.#frames = options.maxQueuedChunks ?? 32
    this.#coalesce = options.coalescePending ?? false
    this.#owner = options.owner
    this.#scheduler = options.scheduler ?? new FairWorkScheduler()
    if (
      !(options.budget instanceof StreamBudget) ||
      typeof options.stopSource !== 'function' ||
      typeof this.#coalesce !== 'boolean' ||
      ![this.#chunk, this.#capacity, this.#frames].every((n) => Number.isSafeInteger(n) && n > 0) ||
      this.#chunk > 64 * 1024 ||
      this.#capacity < this.#chunk ||
      this.#capacity > 16 * 1024 * 1024 ||
      this.#frames > 4096
    )
      throw new TypeError('Invalid callback stream source bounds')
    this.#releaseReservation = options.budget.reserve(options.owner, this.#capacity)
    this.#writer = writer
    this.#stopSource = options.stopSource
    let finished!: (value: StreamOutcome) => void, drained!: () => void
    this.finished = new Promise((resolve) => {
      finished = resolve
    })
    this.drained = new Promise((resolve) => {
      drained = resolve
    })
    this.#resolveFinished = finished
    this.#resolveDrained = drained
    // A disconnected writer must stop an idle source too, not just fail its next write.
    void writer.finished.then(
      (result) => {
        if (!result.ok) this.#fail(result.code)
        else if (!this.#ended) this.#fail('PROTOCOL_ERROR')
      },
      () => this.#fail('CONSUMER_FAILED')
    )
    if (options.signal) {
      const signal = options.signal
      const abort = () => this.cancel()
      signal.addEventListener('abort', abort, { once: true })
      this.#removeAbort = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) this.cancel()
    }
  }
  /** Snapshot only the declared view before returning. False means the source must not continue. */
  push(bytes: Uint8Array): boolean {
    if (this.#ended || this.#settled) return false
    let buffer: unknown, length: number, offset: number
    try {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Invalid source view')
      buffer = backingBuffer.call(bytes)
      length = byteLength.call(bytes)
      offset = byteOffset.call(bytes)
    } catch {
      // Proxies and prototype-only lookalikes have no native typed-array slots.
      // Reject through the owned failure path, not an exception from the callback.
      this.#fail('PROTOCOL_ERROR')
      return false
    }
    if (!(buffer instanceof ArrayBuffer) || !length) {
      this.#fail('PROTOCOL_ERROR')
      return false
    }
    const tail = this.#coalesce ? this.#queue.at(-1) : undefined
    const appended = tail ? Math.min(length, tail.capacity - tail.length) : 0
    const remaining = length - appended
    const count = Math.ceil(remaining / this.#chunk)
    if (
      length > this.#capacity - this.#retained ||
      remaining > this.#capacity - this.#allocated ||
      count > this.#frames - this.#queue.length - Number(this.#active)
    ) {
      this.#fail('OVERLOADED')
      return false
    }
    // Allocate only inside the already-reserved source capacity. Coalescing
    // blocks count their unused slack too; an active or transferred block stays
    // charged until its writer settles. No copy ever modifies an active block.
    const chunks: SourceChunk[] = []
    let allocated = 0
    try {
      for (let cursor = appended; cursor < length;) {
        const size = Math.min(this.#chunk, length - cursor)
        const capacity = this.#coalesce
          ? Math.min(this.#chunk, this.#capacity - this.#allocated - allocated)
          : size
        const chunk = new Uint8Array(capacity)
        chunk.set(new Uint8Array(buffer, offset + cursor, size))
        chunks.push({ bytes: chunk, capacity, length: size })
        allocated += capacity
        cursor += size
      }
      // Stage every new block before changing a previously admitted tail. A
      // failed allocation/copy cancels owned work rather than emitting a prefix.
      if (tail && appended) {
        tail.bytes.set(new Uint8Array(buffer, offset, appended), tail.length)
        tail.length += appended
      }
    } catch {
      this.#fail('OVERLOADED')
      return false
    }
    for (const chunk of chunks) this.#queue.push(chunk)
    this.#allocated += allocated
    this.#peakAllocated = Math.max(this.#peakAllocated, this.#allocated)
    this.#coalescedBytes += appended
    this.#retained += length
    this.#peak = Math.max(this.#peak, this.#retained)
    this.#schedule()
    return true
  }
  /** Source EOF, not subprocess exit. The latter alone does not establish output drain. */
  end(): Promise<StreamOutcome> {
    this.#ended = true
    this.#schedule()
    return this.finished
  }
  cancel(): void {
    this.#fail('CANCELLED')
  }
  #schedule(): void {
    if (this.#active || this.#scheduled || this.#settled) return
    // A later microtask can refill an empty queue without giving control work
    // a turn. Retain the quantum until our actual event-loop yield executes.
    if (!this.#queue.length && !this.#ended) return
    const scheduled = this.#scheduler.schedule(
      this.#owner,
      () => {
        if (this.#scheduled === scheduled) this.#scheduled = undefined
        void this.#pump()
      },
      { onYield: () => this.#yieldCount++ }
    )
    if (!scheduled) {
      this.#fail('OVERLOADED')
      return
    }
    this.#scheduled = scheduled
  }
  async #pump(): Promise<void> {
    if (this.#active || this.#settled) return
    const chunk = this.#queue.shift()
    if (!chunk && !this.#ended) return
    // A writer may transfer (detach) the supplied buffer during handoff. Keep
    // its admitted size until settlement rather than rereading a detached view.
    const length = chunk?.length ?? 0
    const allocated = chunk?.capacity ?? 0
    this.#active = true
    try {
      if (chunk) {
        await this.#writer.write(chunk.bytes.subarray(0, length))
        this.#acknowledgedBytes += length
      } else {
        await this.#writer.end()
        const result = await this.#writer.finished
        if (!result.ok) this.#fail(result.code)
        else if (!this.#settled) {
          this.#settled = true
          this.#removeAbort()
          this.#resolveFinished(Object.freeze({ ok: true }))
        }
      }
    } catch (error) {
      this.#fail(error instanceof StreamError ? error.code : 'CONSUMER_FAILED')
    } finally {
      if (chunk) {
        this.#retained -= length
        this.#allocated -= allocated
      }
      this.#active = false
      this.#collect()
      this.#schedule()
    }
  }
  #fail(code: StreamErrorCode): void {
    if (this.#settled) return
    this.#settled = true
    this.#reason = code
    this.#ended = true
    this.#scheduled?.cancel()
    this.#scheduled = undefined
    this.#removeAbort()
    for (const chunk of this.#queue) {
      this.#retained -= chunk.length
      this.#allocated -= chunk.capacity
    }
    this.#queue.length = 0
    // Mark retired before callbacks: stopping/cancellation may synchronously reenter.
    try {
      this.#stopSource(code)
    } catch {
      this.#sourceStopFailed = true
    }
    try {
      this.#writer.cancel()
    } catch {
      /* Caller failure still settles; active bytes stay accounted. */
    }
    this.#resolveFinished(Object.freeze({ ok: false, code }))
    this.#collect()
  }
  #collect(): void {
    if (!this.#settled || this.#active || this.#released) return
    this.#released = true
    this.#releaseReservation()
    this.#resolveDrained()
  }
  diagnostics() {
    return Object.freeze({
      retainedBytes: this.#retained,
      allocatedBytes: this.#allocated,
      peakAllocatedBytes: this.#peakAllocated,
      coalescedBytes: this.#coalescedBytes,
      coalescing: this.#coalesce,
      peakRetainedBytes: this.#peak,
      queuedChunks: this.#queue.length + Number(this.#active),
      acknowledgedBytes: this.#acknowledgedBytes,
      reservedBytes: this.#released ? 0 : this.#capacity,
      ended: this.#ended,
      settled: this.#settled,
      reason: this.#reason ?? null,
      sourceStopFailed: this.#sourceStopFailed,
      drainQuantum: DRAIN_CHUNKS_PER_TURN,
      yieldCount: this.#yieldCount,
      yieldPending: this.#scheduled?.pending ?? false,
      droppedBytes: 0,
      scheduler: this.#scheduler.diagnostics(),
    })
  }
}
