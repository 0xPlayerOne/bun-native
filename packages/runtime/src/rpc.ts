import { DiagnosticObserverBudget } from './diagnostic-observer.ts'
import {
  RpcError,
  defineRpc,
  rpcLimits,
  rpcScheduler,
  validProcedure,
} from '../../contracts/src/rpc.ts'
import type {
  RpcSchema,
  RpcInput,
  RpcOutput,
  RpcLimits,
  RpcScheduler,
  RpcTransport,
  RpcErrorCode,
} from '../../contracts/src/rpc.ts'
import { encodeRpc, decodeRpc } from '../../contracts/src/rpc-wire.ts'
import { RpcChannel } from '../../contracts/src/rpc-channel.ts'
import { claimRpcAuthority } from './rpc-authority.ts'
import type { RpcLease, RpcIdentity, RpcAuthorityGuard } from './rpc-authority.ts'
export interface RpcContext {
  readonly identity: RpcIdentity
  readonly signal: AbortSignal
}
export type RpcHandlers<S extends RpcSchema> = {
  readonly [K in keyof S]: {
    readonly capability: string
    readonly handle: (
      input: RpcInput<S[K]>,
      context: RpcContext
    ) => RpcOutput<S[K]> | Promise<RpcOutput<S[K]>>
  }
}
export interface RpcDiagnostic {
  readonly stage: 'started' | 'settled'
  readonly outcome: 'pending' | 'success' | 'error' | 'cancelled' | 'deadline' | 'disconnected'
  readonly elapsedMs: number
}
export interface RpcServerOptions {
  readonly limits?: Partial<RpcLimits>
  readonly scheduler?: RpcScheduler
  /** Optional fixed-metadata observations; no method, identifiers or payloads are included. */
  readonly onDiagnostic?: (event: RpcDiagnostic) => void
}
interface Job {
  readonly release: () => void
  readonly id: number
  readonly controller: AbortController
  readonly deadline: number
  readonly started: number
  outcome: RpcDiagnostic['outcome']
  timer: unknown
  timerSet: boolean
  replied: boolean
}
interface Route {
  readonly parseInput: (v: unknown) => unknown
  readonly parseOutput: (v: unknown) => unknown
  readonly capability: string
  readonly handle: (input: unknown, context: RpcContext) => unknown
}
export class RpcServer<S extends RpcSchema> {
  readonly #routes = new Map<string, Route>()
  readonly #jobs = new Map<number, Job>()
  readonly #parsing = new Map<number, { cancelled: boolean }>()
  readonly #limits: RpcLimits
  readonly #clock: RpcScheduler
  readonly #guard: RpcAuthorityGuard
  readonly #channel: RpcChannel
  readonly #revoked: () => void
  readonly #onDiagnostic: RpcServerOptions['onDiagnostic']
  readonly #diagnosticQueue: RpcDiagnostic[] = []
  readonly #observerBudget = new DiagnosticObserverBudget()
  #diagnosticScheduled = false
  #sequence = 0
  #closed = false
  #pendingReplies = 0
  #idleWaiter:
    | {
        promise: Promise<void>
        resolve(): void
        reject(error: RpcError): void
        timer: unknown
        timerSet: boolean
        deadline: number
      }
    | undefined
  readonly closed: Promise<RpcError>
  constructor(
    schema: S,
    handlers: RpcHandlers<S>,
    lease: RpcLease,
    transport: RpcTransport,
    options: RpcServerOptions = {}
  ) {
    const contract = defineRpc(schema)
    if (Object.keys(handlers).length !== Object.keys(contract).length)
      throw new TypeError('RPC handlers must match the contract')
    for (const [name, definition] of Object.entries(contract)) {
      const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined
      if (!handler || !validProcedure(handler.capability) || typeof handler.handle !== 'function')
        throw new TypeError('RPC route requires an explicit capability and handler')
      this.#routes.set(name, {
        parseInput: definition.input,
        parseOutput: definition.output,
        capability: handler.capability,
        handle: handler.handle as (input: unknown, context: RpcContext) => unknown,
      })
    }
    if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== 'function')
      throw new TypeError('Invalid RPC diagnostic observer')
    this.#onDiagnostic = options.onDiagnostic
    this.#limits = rpcLimits(options.limits)
    this.#clock = options.scheduler ?? rpcScheduler
    this.#guard = claimRpcAuthority(lease)
    this.#channel = new RpcChannel(
      transport,
      this.#limits,
      this.#clock,
      (packet) => this.#receive(packet),
      (reason) => this.#disconnect(reason)
    )
    this.closed = this.#channel.closed
    this.#revoked = () =>
      this.#channel.close(new RpcError('REVOKED', 'RPC document authority was revoked'))
    this.#guard.signal.addEventListener('abort', this.#revoked, { once: true })
    this.#channel.start()
    if (this.#guard.signal.aborted) this.#revoked()
  }
  #diagnostic(job: Job, stage: RpcDiagnostic['stage'], outcome: RpcDiagnostic['outcome']): void {
    if (!this.#onDiagnostic || this.#diagnosticQueue.length >= 128) return
    let elapsed: number
    try {
      elapsed = this.#clock.now() - job.started
    } catch {
      // Observability must never change request settlement or reject detached work.
      return
    }
    this.#diagnosticQueue.push(
      Object.freeze({
        stage,
        outcome,
        elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.min(600000, elapsed)) : 0,
      })
    )
    if (this.#diagnosticScheduled) return
    this.#diagnosticScheduled = true
    queueMicrotask(() => {
      this.#diagnosticScheduled = false
      const pending = this.#diagnosticQueue.splice(0)
      for (const event of pending) {
        if (this.#onDiagnostic) this.#observerBudget.invoke(this.#onDiagnostic, event)
      }
    })
  }
  #receive(packet: Uint8Array): void {
    const message = decodeRpc(packet, this.#limits)
    if (message.type === 'cancel') {
      const parsing = this.#parsing.get(message.id)
      if (parsing) parsing.cancelled = true
      const job = this.#jobs.get(message.id)
      if (job && !job.replied) this.#cancel(job, 'CANCELLED')
      return
    }
    if (message.type !== 'request') throw new RpcError('PROTOCOL_ERROR', 'Expected an RPC request')
    if (message.id <= this.#sequence)
      throw new RpcError('PROTOCOL_ERROR', 'Replayed or out-of-order RPC request')
    this.#sequence = message.id
    const route = this.#routes.get(message.method)
    if (!route) {
      this.#error(message.id, 'NOT_FOUND')
      return
    }
    if (this.#jobs.size + this.#parsing.size >= this.#limits.maxHandlers) {
      this.#error(message.id, 'OVERLOADED')
      return
    }
    const parsing = { cancelled: false }
    this.#parsing.set(message.id, parsing)
    let release: (() => void) | undefined
    try {
      try {
        this.#guard.check(route.capability)
      } catch (error) {
        this.#error(message.id, error instanceof RpcError ? error.code : 'FORBIDDEN')
        return
      }
      if (this.#closed) return
      if (parsing.cancelled) {
        this.#error(message.id, 'CANCELLED')
        return
      }
      const deadline = this.#clock.now() + message.timeoutMs
      if (this.#closed) return
      if (parsing.cancelled) {
        this.#error(message.id, 'CANCELLED')
        return
      }
      let input: unknown
      try {
        input = route.parseInput(message.value)
      } catch {
        this.#error(message.id, 'BAD_REQUEST')
        return
      }
      if (this.#closed) return
      if (parsing.cancelled) {
        this.#error(message.id, 'CANCELLED')
        return
      }
      try {
        this.#guard.check(route.capability)
      } catch (error) {
        this.#error(message.id, error instanceof RpcError ? error.code : 'REVOKED')
        return
      }
      if (this.#closed) return
      if (parsing.cancelled) {
        this.#error(message.id, 'CANCELLED')
        return
      }
      try {
        release = this.#guard.acquire()
      } catch (error) {
        this.#error(message.id, error instanceof RpcError ? error.code : 'REVOKED')
        return
      }
      if (this.#closed) return
      if (parsing.cancelled) {
        this.#error(message.id, 'CANCELLED')
        return
      }
      const started = this.#clock.now()
      if (this.#closed) return
      if (parsing.cancelled) {
        this.#error(message.id, 'CANCELLED')
        return
      }
      const job: Job = {
        release,
        id: message.id,
        controller: new AbortController(),
        deadline,
        started,
        outcome: 'error',
        timer: undefined,
        timerSet: false,
        replied: false,
      }
      this.#parsing.delete(message.id)
      this.#jobs.set(job.id, job)
      release = undefined
      try {
        const remaining = Math.max(0, deadline - this.#clock.now())
        if (job.replied || this.#closed) {
          this.#jobs.delete(job.id)
          job.release()
          this.#settleIdle()
          return
        }
        const timer = this.#clock.set(remaining, () => this.#cancel(job, 'DEADLINE_EXCEEDED'))
        job.timer = timer
        job.timerSet = true
        if (job.replied || this.#closed) {
          this.#clearJobTimer(job)
          this.#jobs.delete(job.id)
          job.release()
          this.#settleIdle()
          return
        }
        this.#diagnostic(job, 'started', 'pending')
        void this.#run(job, route, input)
      } catch (error) {
        this.#jobs.delete(job.id)
        if (job.timerSet) this.#clearJobTimer(job)
        job.release()
        throw error
      }
    } finally {
      this.#parsing.delete(message.id)
      release?.()
    }
  }

  async #run(job: Job, route: Route, input: unknown): Promise<void> {
    try {
      if (job.replied || this.#closed) return
      const now = this.#clock.now()
      if (job.replied || this.#closed) return
      if (now >= job.deadline) {
        this.#cancel(job, 'DEADLINE_EXCEEDED')
        return
      }
      const value = await route.handle(
        input,
        Object.freeze({ identity: this.#guard.identity, signal: job.controller.signal })
      )
      if (job.replied || this.#closed) return
      if (this.#clock.now() >= job.deadline) {
        this.#cancel(job, 'DEADLINE_EXCEEDED')
        return
      }
      if (job.replied || this.#closed) return
      this.#guard.check(route.capability)
      if (job.replied || this.#closed) return
      const output = route.parseOutput(value)
      // Output validation can also take time or trigger application lifecycle work.
      if (job.replied || this.#closed) return
      if (this.#clock.now() >= job.deadline) {
        this.#cancel(job, 'DEADLINE_EXCEEDED')
        return
      }
      if (job.replied || this.#closed) return
      this.#guard.check(route.capability)
      if (job.replied || this.#closed) return
      const packet = encodeRpc({ type: 'success', id: job.id, value: output }, this.#limits)
      // Validation and serialization can synchronously run application code.
      // Revalidate before committing a terminal success.
      if (job.replied || this.#closed) return
      const encodedAt = this.#clock.now()
      if (job.replied || this.#closed) return
      if (encodedAt >= job.deadline) {
        this.#cancel(job, 'DEADLINE_EXCEEDED')
        return
      }
      this.#guard.check(route.capability)
      if (job.replied || this.#closed) return
      job.replied = true
      job.outcome = 'success'
      this.#clearJobTimer(job)
      this.#send(packet, () => {
        this.#guard.check(route.capability)
        if (this.#clock.now() >= job.deadline)
          throw new RpcError('DEADLINE_EXCEEDED', 'RPC result expired before delivery')
      })
    } catch {
      // Never expose arbitrary exception text, validation internals, paths or stacks.
      if (!job.replied && !this.#closed) {
        job.replied = true
        this.#error(job.id, 'INTERNAL')
      }
    } finally {
      this.#clearJobTimer(job)
      this.#jobs.delete(job.id)
      job.release()
      this.#settleIdle()
      this.#diagnostic(job, 'settled', job.outcome)
    }
  }
  #clearJobTimer(job: Job): void {
    if (!job.timerSet) return
    job.timerSet = false
    try {
      this.#clock.clear(job.timer)
    } catch {
      /* Continue releasing owned work. */
    }
  }
  #cancel(job: Job, code: 'CANCELLED' | 'DEADLINE_EXCEEDED'): void {
    if (job.replied) return
    job.replied = true
    job.outcome = code === 'CANCELLED' ? 'cancelled' : 'deadline'
    this.#clearJobTimer(job)
    job.controller.abort(
      new RpcError(code, code === 'CANCELLED' ? 'RPC call cancelled' : 'RPC deadline exceeded')
    )
    if (!this.#closed) this.#error(job.id, code)
    // Keep the execution slot until an uncooperative handler actually settles.
    // Otherwise cancel/retry floods could launch unbounded still-running work.
  }
  #error(id: number, code: RpcErrorCode): void {
    const message = `RPC ${code.toLowerCase().replaceAll('_', ' ')}`
    this.#send(encodeRpc({ type: 'error', id, code, message }, this.#limits))
  }
  #send(packet: Uint8Array, beforeSend?: () => void): void {
    if (this.#closed) return
    this.#pendingReplies++
    void this.#channel.send(packet, undefined, beforeSend).then(
      () => {
        this.#pendingReplies--
        this.#settleIdle()
      },
      (error) => {
        this.#pendingReplies--
        this.#channel.close(
          error instanceof RpcError
            ? error
            : new RpcError('DISCONNECTED', 'RPC response delivery failed')
        )
      }
    )
  }
  #disconnect(reason: RpcError): void {
    if (this.#closed) return
    this.#closed = true
    this.#settleIdle(reason)
    this.#guard.signal.removeEventListener('abort', this.#revoked)
    for (const job of this.#jobs.values()) {
      if (!job.replied) job.outcome = 'disconnected'
      job.replied = true
      this.#clearJobTimer(job)
      job.controller.abort(reason)
    }
  }
  /** Wait for currently admitted handlers AND adapter-completed replies.
   * Call outside a handler, with producers quiescent. This does not freeze new requests.
   * One waiter is coalesced per server, under the existing send deadline; timeout
   * or revocation rejects without releasing any execution or native reservation.
   */
  whenIdle(): Promise<void> {
    if (this.#closed) return Promise.reject(new RpcError('DISCONNECTED', 'RPC server closed'))
    if (!this.#jobs.size && !this.#parsing.size && !this.#pendingReplies) return Promise.resolve()
    if (this.#idleWaiter) return this.#idleWaiter.promise
    let resolve!: () => void, reject!: (error: RpcError) => void
    const promise = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    void promise.catch(() => {})
    const waiter = {
      promise,
      resolve,
      reject,
      timer: undefined as unknown,
      timerSet: false,
      deadline: Infinity,
    }
    this.#idleWaiter = waiter
    try {
      waiter.deadline = this.#clock.now() + this.#limits.sendTimeoutMs
      if (this.#idleWaiter !== waiter) return promise
      const timer = this.#clock.set(this.#limits.sendTimeoutMs, () =>
        this.#settleIdle(new RpcError('DEADLINE_EXCEEDED', 'RPC idle deadline exceeded'))
      )
      if (this.#idleWaiter !== waiter) {
        try {
          this.#clock.clear(timer)
        } catch {
          /* Continue after settlement. */
        }
        return promise
      }
      waiter.timer = timer
      waiter.timerSet = true
    } catch {
      if (this.#idleWaiter === waiter)
        this.#settleIdle(new RpcError('INTERNAL', 'RPC idle timer failed'))
    }
    return promise
  }
  #settleIdle(error?: RpcError): void {
    const waiter = this.#idleWaiter
    if (!waiter) return
    if (!error) {
      try {
        if (this.#clock.now() >= waiter.deadline)
          error = new RpcError('DEADLINE_EXCEEDED', 'RPC idle deadline exceeded')
      } catch {
        error = new RpcError('INTERNAL', 'RPC idle clock failed')
      }
      if (this.#idleWaiter !== waiter) return
    }
    if (!error && (this.#jobs.size || this.#parsing.size || this.#pendingReplies)) return
    this.#idleWaiter = undefined
    if (waiter.timerSet) {
      try {
        this.#clock.clear(waiter.timer)
      } catch {
        /* Continue settlement. */
      }
    }
    if (error) waiter.reject(error)
    else waiter.resolve()
  }
  close(): void {
    this.#channel.close()
  }
  diagnostics(): Readonly<{
    executing: number
    cancelledExecuting: number
    queuedBytes: number
    queuedFrames: number
    peakQueuedBytes: number
    peakQueuedFrames: number
    closed: boolean
  }> {
    return {
      executing: this.#jobs.size,
      cancelledExecuting: [...this.#jobs.values()].filter((j) => j.controller.signal.aborted)
        .length,
      ...this.#channel.diagnostics(),
    }
  }
}
