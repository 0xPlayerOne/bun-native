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
export interface RpcServerOptions {
  readonly limits?: Partial<RpcLimits>
  readonly scheduler?: RpcScheduler
}
interface Job {
  readonly release: () => void
  readonly id: number
  readonly controller: AbortController
  readonly deadline: number
  timer: unknown
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
  readonly #limits: RpcLimits
  readonly #clock: RpcScheduler
  readonly #guard: RpcAuthorityGuard
  readonly #channel: RpcChannel
  readonly #revoked: () => void
  #sequence = 0
  #closed = false
  #pendingReplies = 0
  #idleWaiter:
    | {
        promise: Promise<void>
        resolve(): void
        reject(error: RpcError): void
        timer: unknown
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
  #receive(packet: Uint8Array): void {
    const message = decodeRpc(packet, this.#limits)
    if (message.type === 'cancel') {
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
    try {
      this.#guard.check(route.capability)
    } catch (error) {
      this.#error(message.id, error instanceof RpcError ? error.code : 'FORBIDDEN')
      return
    }
    if (this.#jobs.size >= this.#limits.maxHandlers) {
      this.#error(message.id, 'OVERLOADED')
      return
    }
    const deadline = this.#clock.now() + message.timeoutMs
    let input: unknown
    try {
      input = route.parseInput(message.value)
    } catch {
      this.#error(message.id, 'BAD_REQUEST')
      return
    }
    // Parsers are trusted application code but may synchronously revoke a grant.
    try {
      this.#guard.check(route.capability)
    } catch {
      this.#error(message.id, 'REVOKED')
      return
    }
    let release: () => void
    try {
      release = this.#guard.acquire()
    } catch (error) {
      this.#error(message.id, error instanceof RpcError ? error.code : 'OVERLOADED')
      return
    }
    const job: Job = {
      release,
      id: message.id,
      controller: new AbortController(),
      deadline,
      timer: undefined,
      replied: false,
    }
    this.#jobs.set(job.id, job)
    job.timer = this.#clock.set(Math.max(0, deadline - this.#clock.now()), () =>
      this.#cancel(job, 'DEADLINE_EXCEEDED')
    )
    void this.#run(job, route, input)
  }
  async #run(job: Job, route: Route, input: unknown): Promise<void> {
    try {
      if (this.#clock.now() >= job.deadline) {
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
      this.#guard.check(route.capability)
      const output = route.parseOutput(value)
      // Output validation can also take time or trigger application lifecycle work.
      if (job.replied || this.#closed) return
      if (this.#clock.now() >= job.deadline) {
        this.#cancel(job, 'DEADLINE_EXCEEDED')
        return
      }
      this.#guard.check(route.capability)
      const packet = encodeRpc({ type: 'success', id: job.id, value: output }, this.#limits)
      job.replied = true
      this.#clock.clear(job.timer)
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
      this.#clock.clear(job.timer)
      this.#jobs.delete(job.id)
      job.release()
      this.#settleIdle()
    }
  }
  #cancel(job: Job, code: 'CANCELLED' | 'DEADLINE_EXCEEDED'): void {
    if (job.replied) return
    job.replied = true
    this.#clock.clear(job.timer)
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
      job.replied = true
      this.#clock.clear(job.timer)
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
    if (!this.#jobs.size && !this.#pendingReplies) return Promise.resolve()
    if (this.#idleWaiter) return this.#idleWaiter.promise
    let resolve!: () => void, reject!: (error: RpcError) => void
    const promise = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    void promise.catch(() => {})
    const deadline = this.#clock.now() + this.#limits.sendTimeoutMs
    const timer = this.#clock.set(this.#limits.sendTimeoutMs, () =>
      this.#settleIdle(new RpcError('DEADLINE_EXCEEDED', 'RPC idle deadline exceeded'))
    )
    this.#idleWaiter = { promise, resolve, reject, timer, deadline }
    return promise
  }
  #settleIdle(error?: RpcError): void {
    const waiter = this.#idleWaiter
    if (!waiter) return
    if (!error && this.#clock.now() >= waiter.deadline)
      error = new RpcError('DEADLINE_EXCEEDED', 'RPC idle deadline exceeded')
    if (!error && (this.#jobs.size || this.#pendingReplies)) return
    this.#idleWaiter = undefined
    this.#clock.clear(waiter.timer)
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
