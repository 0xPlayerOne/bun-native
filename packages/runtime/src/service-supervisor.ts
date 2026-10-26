import { rpcScheduler, type RpcScheduler } from '../../contracts/src/rpc.ts'
import type { BinaryStreamWriter, StreamOutcome } from '../../contracts/src/streams.ts'
import {
  TerminalError,
  TerminalService,
  type TerminalClosure,
  type TerminalLaunch,
  type TerminalProcessExit,
  type TerminalSpawnOptions,
} from './terminal.ts'

const generationBrand: unique symbol = Symbol('bunly.service-generation')
export interface ServiceGeneration {
  readonly attempt: number
  readonly [generationBrand]: true
}
export type ServiceState = 'starting' | 'ready' | 'stopping' | 'backoff' | 'failed' | 'stopped'
export type ServiceReadiness =
  | 'pending'
  | 'driver-attached'
  | 'handshake'
  | 'rejected'
  | 'timed-out'
  | 'cancelled'
  | 'exited'
export type ServiceFailure =
  | 'STARTUP_TIMEOUT'
  | 'OUTPUT_FACTORY_FAILED'
  | 'SPAWN_FAILED'
  | 'READINESS_FAILED'
  | 'PROCESS_FAILED'
  | 'CLEANUP_UNOBSERVED'
  | 'OUTPUT_FAILED'
  | 'OUTPUT_DISPOSE_FAILED'
  | 'ATTEMPTS_EXHAUSTED'
  | 'RESTART_DEADLINE'
export type ServiceRestartPolicy =
  | { readonly mode: 'never' }
  | {
      readonly mode: 'on-failure'
      /** Total lifetime attempts, including the initial launch. */
      readonly maxAttempts: number
      readonly initialBackoffMs: number
      readonly maxBackoffMs: number
      /** Absolute restart admission window measured from start(), never reset by readiness. */
      readonly totalBudgetMs: number
    }
export interface ServiceSnapshot {
  readonly state: ServiceState
  readonly generation: ServiceGeneration | null
  readonly attempts: number
  readonly readiness: ServiceReadiness
  readonly failure: ServiceFailure | null
  readonly exit: TerminalProcessExit | null
  readonly terminal: TerminalClosure | null
  readonly output: StreamOutcome | null
  readonly cleanupPending: boolean
  readonly nextAttemptAt: number | null
}
export interface ServiceOutput {
  readonly writer: BinaryStreamWriter
  /** Release the generation's consumer/stream resources after terminal release. */
  dispose(): void | Promise<void>
}
export interface ServiceCallbackContext {
  readonly generation: ServiceGeneration
  readonly signal: AbortSignal
}
export interface ServiceSupervisorOptions {
  readonly service: TerminalService
  readonly owner: object
  readonly launch: Omit<TerminalSpawnOptions, 'signal'>
  /** Must allocate a NEW bounded writer/consumer for every generation. */
  readonly createOutput: (context: ServiceCallbackContext) => ServiceOutput | Promise<ServiceOutput>
  /** True establishes exactly the application's predicate; no implicit socket/server probe. */
  readonly readiness?: (context: ServiceCallbackContext) => boolean | Promise<boolean>
  /** Bounds output creation + spawn + optional readiness, including late completions. */
  readonly startupTimeoutMs?: number
  readonly restart?: ServiceRestartPolicy
  readonly signal?: AbortSignal
  /** One observer, one in-flight call and one coalesced latest snapshot; exceptions isolated. */
  readonly onChange?: (snapshot: ServiceSnapshot) => void | Promise<void>
  readonly scheduler?: RpcScheduler
}
interface Attempt {
  readonly identity: ServiceGeneration
  readonly controller: AbortController
  readonly deadline: number
  launch?: TerminalLaunch
  outputLease?: ServiceOutput
  failed: boolean
  retry: boolean
  ending: boolean
  outputCancellation: boolean
}
function integer(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= max
}

/** Explicit application child restart. Never a Bun backend reload manager or process-tree owner. */
export class ServiceSupervisor {
  readonly #service: TerminalService
  readonly #owner: object
  readonly #launch: Omit<TerminalSpawnOptions, 'signal'>
  readonly #clock: RpcScheduler
  readonly #policy: ServiceRestartPolicy
  readonly #timeout: number
  #factory: ServiceSupervisorOptions['createOutput'] | undefined
  #readiness: ServiceSupervisorOptions['readiness']
  #observer: ServiceSupervisorOptions['onChange']
  #observerBusy = false
  #queuedSnapshot: ServiceSnapshot | undefined
  #observerIdle: Promise<void> = Promise.resolve()
  #observerWait: (() => void) | undefined
  #observerFailures = 0
  #removeAbort = () => {}
  #timer: unknown
  #timerEpoch = 0
  #attempt: Attempt | undefined
  #started = false
  #retired = false
  #disposed = false
  #settled = false
  #restartDeadline = 0
  #writers = new WeakSet<object>()
  #resolveSettled!: (snapshot: ServiceSnapshot) => void
  /** Actual work settlement, not a synthetic timeout. Can remain pending for an uncooperative owner. */
  readonly settled = new Promise<ServiceSnapshot>((resolve) => {
    this.#resolveSettled = resolve
  })
  #snapshot: ServiceSnapshot = Object.freeze({
    state: 'stopped',
    generation: null,
    attempts: 0,
    readiness: 'pending',
    failure: null,
    exit: null,
    terminal: null,
    output: null,
    cleanupPending: false,
    nextAttemptAt: null,
  })

  constructor(options: ServiceSupervisorOptions) {
    // Capture and validate all callbacks before registering listeners or acquiring resources.
    const { createOutput, readiness, onChange, signal } = options
    const timeout = options.startupTimeoutMs ?? 5_000
    const policy = { ...(options.restart ?? { mode: 'never' as const }) }
    if (
      !(options.service instanceof TerminalService) ||
      !options.owner ||
      typeof options.owner !== 'object' ||
      typeof createOutput !== 'function' ||
      (readiness !== undefined && typeof readiness !== 'function') ||
      (onChange !== undefined && typeof onChange !== 'function') ||
      !integer(timeout, 60_000) ||
      !['never', 'on-failure'].includes(policy.mode)
    )
      throw new TypeError('Invalid supervisor configuration')
    if (
      policy.mode === 'on-failure' &&
      (!integer(policy.maxAttempts, 1024) ||
        !integer(policy.initialBackoffMs, 60_000) ||
        !integer(policy.maxBackoffMs, 60_000) ||
        policy.initialBackoffMs > policy.maxBackoffMs ||
        !integer(policy.totalBudgetMs, 86_400_000))
    )
      throw new TypeError('Invalid finite restart policy')
    if (signal !== undefined)
      Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(signal)
    this.#service = options.service
    this.#owner = options.owner
    // Snapshot caller configuration once. TerminalService still validates every admission.
    const launch = { ...options.launch }
    if ('signal' in launch) throw new TypeError('Use the supervisor lifetime signal')
    this.#launch = Object.freeze({
      ...launch,
      ...(launch.argv ? { argv: Object.freeze([...launch.argv]) } : {}),
      ...(launch.env ? { env: Object.freeze({ ...launch.env }) } : {}),
    })
    this.#factory = createOutput
    this.#readiness = readiness
    this.#observer = onChange
    this.#policy = Object.freeze(policy)
    this.#timeout = timeout
    this.#clock = options.scheduler ?? rpcScheduler
    if (signal) {
      const abort = () => this.stop()
      EventTarget.prototype.addEventListener.call(signal, 'abort', abort, { once: true })
      this.#removeAbort = () =>
        EventTarget.prototype.removeEventListener.call(signal, 'abort', abort)
      if (signal.aborted) this.stop()
    }
  }
  get snapshot(): ServiceSnapshot {
    return this.#snapshot
  }
  diagnostics() {
    return Object.freeze({
      timer: this.#timer === undefined ? 0 : 1,
      activeGenerations: this.#attempt ? 1 : 0,
      observerCalls: this.#observerBusy ? 1 : 0,
      queuedSnapshots: this.#queuedSnapshot ? 1 : 0,
      observerFailures: this.#observerFailures,
      disposed: this.#disposed,
    })
  }
  start(): void {
    if (this.#started || this.#retired) throw new TerminalError('DISPOSED')
    this.#started = true
    this.#restartDeadline =
      this.#clock.now() + (this.#policy.mode === 'on-failure' ? this.#policy.totalBudgetMs : 0)
    this.#begin()
  }
  stop(): void {
    if (this.#retired) return
    this.#retired = true
    this.#clearTimer()
    this.#detachAbort()
    const attempt = this.#attempt
    if (attempt) {
      attempt.retry = false
      attempt.outputCancellation = true
      attempt.ending = true
      this.#update({
        state: 'stopping',
        readiness: this.#snapshot.readiness === 'pending' ? 'cancelled' : this.#snapshot.readiness,
        nextAttemptAt: null,
      })
      // A live handle uses TerminalService's finite graceful close/escalation. During
      // spawn its own cancellation fencing stops the late returned exact driver.
      if (attempt.launch) void this.#service.close(attempt.launch.handle)
      attempt.controller.abort()
    } else {
      this.#update({ state: 'stopped', nextAttemptAt: null })
      this.#finish()
    }
  }
  dispose(): void {
    this.#disposed = true
    this.#observer = undefined
    this.#queuedSnapshot = undefined
    this.stop()
    this.#factory = undefined
    this.#readiness = undefined
  }
  write(generation: ServiceGeneration, bytes: Uint8Array): Promise<void> {
    return this.#service.write(this.#target(generation).launch!.handle, bytes)
  }
  resize(generation: ServiceGeneration, cols: number, rows: number): void {
    this.#service.resize(this.#target(generation).launch!.handle, cols, rows)
  }
  signal(generation: ServiceGeneration, signal: NodeJS.Signals): void {
    const attempt = this.#target(generation)
    attempt.retry = false // An explicit signal never authorizes replacement.
    this.#service.signal(attempt.launch!.handle, signal)
  }
  close(generation: ServiceGeneration): void {
    this.#target(generation)
    this.stop()
  }
  #target(generation: ServiceGeneration): Attempt {
    const attempt = this.#attempt
    if (
      !attempt ||
      attempt.identity !== generation ||
      !attempt.launch ||
      attempt.ending ||
      this.#retired
    )
      throw new TerminalError('INVALID_HANDLE')
    return attempt
  }
  #begin(): void {
    if (this.#retired) return
    const attempt: Attempt = {
      identity: Object.freeze({
        attempt: this.#snapshot.attempts + 1,
        [generationBrand]: true as const,
      }),
      controller: new AbortController(),
      deadline: this.#clock.now() + this.#timeout,
      failed: false,
      retry: true,
      ending: false,
      outputCancellation: false,
    }
    this.#attempt = attempt
    this.#update({
      state: 'starting',
      generation: attempt.identity,
      attempts: attempt.identity.attempt,
      readiness: 'pending',
      failure: null,
      exit: null,
      terminal: null,
      output: null,
      cleanupPending: true,
      nextAttemptAt: null,
    })
    if (!attempt.ending)
      this.#arm(attempt.deadline, () => this.#fail(attempt, 'STARTUP_TIMEOUT', true, 'timed-out'))
    void this.#run(attempt)
  }
  #fail(
    attempt: Attempt,
    failure: ServiceFailure,
    retry: boolean,
    readiness?: ServiceReadiness
  ): void {
    if (this.#attempt !== attempt) return
    attempt.failed = true
    attempt.outputCancellation = true
    attempt.retry &&= retry
    attempt.ending = true
    this.#clearTimer()
    this.#update({
      state: this.#retired ? 'stopping' : 'failed',
      failure,
      ...(readiness ? { readiness } : {}),
    })
    if (attempt.launch) void this.#service.close(attempt.launch.handle)
    attempt.controller.abort()
  }
  async #run(attempt: Attempt): Promise<void> {
    let disposeOutput: (() => void | Promise<void>) | undefined
    let unknownOutput = false
    try {
      if (attempt.ending) return
      const context = Object.freeze({
        generation: attempt.identity,
        signal: attempt.controller.signal,
      })
      let writer: BinaryStreamWriter
      try {
        const output = await this.#factory!(context)
        attempt.outputLease = output
        unknownOutput = true
        const { writer: supplied, dispose } = output
        if (typeof dispose !== 'function') throw new TypeError('Output disposal required')
        disposeOutput = () => dispose.call(output)
        unknownOutput = false
        if (!supplied || typeof supplied !== 'object' || this.#writers.has(supplied))
          throw new TypeError('A new complete writer is required')
        const { write, end, cancel, finished } = supplied
        // Observe before validating other methods, even if this resource will not launch.
        if (finished instanceof Promise) void finished.catch(() => {})
        if (
          typeof write !== 'function' ||
          typeof end !== 'function' ||
          typeof cancel !== 'function' ||
          !(finished instanceof Promise)
        )
          throw new TypeError('A new complete writer is required')
        this.#writers.add(supplied)
        writer = Object.freeze({
          write: (bytes: Uint8Array) => write.call(supplied, bytes),
          end: () => end.call(supplied),
          cancel: () => cancel.call(supplied),
          finished,
        })
        if (this.#clock.now() >= attempt.deadline && !attempt.ending)
          this.#fail(attempt, 'STARTUP_TIMEOUT', true, 'timed-out')
        if (attempt.ending) {
          writer.cancel()
          return
        }
      } catch {
        this.#fail(attempt, 'OUTPUT_FACTORY_FAILED', false)
        return
      }
      let launch: TerminalLaunch
      try {
        launch = this.#service.launch(this.#owner, writer, { ...this.#launch })
        attempt.launch = launch
        if (attempt.ending) void this.#service.close(launch.handle)
      } catch {
        this.#fail(attempt, 'SPAWN_FAILED', false)
        writer.cancel()
        return
      }
      const observation = launch.observation
      // Register before awaiting started: drivers may report exit before spawn returns.
      const processDone = observation.processExited.then((exit) => {
        this.#update({ exit })
        if (!exit.observed || exit.waitError || exit.failure) {
          this.#fail(attempt, 'CLEANUP_UNOBSERVED', false)
        } else if (!attempt.ending) {
          attempt.ending = true
          this.#clearTimer()
          attempt.failed = exit.exitCode !== 0 || exit.signalCode !== null
          this.#update({
            state: attempt.failed ? 'failed' : 'stopping',
            failure: attempt.failed ? 'PROCESS_FAILED' : null,
            readiness: this.#snapshot.readiness === 'pending' ? 'exited' : this.#snapshot.readiness,
          })
          attempt.controller.abort()
        }
      })
      const terminalDone = observation.terminalClosed.then((terminal) => {
        this.#update({ terminal })
        if (!terminal.observed || terminal.failure) this.#fail(attempt, 'CLEANUP_UNOBSERVED', false)
      })
      const outputDone = observation.outputFinished.then((result) => {
        this.#update({ output: Object.freeze({ ...result }) })
        // Only cancellation caused by OUR readiness/stop path is eligible. Overflow,
        // peer revocation and consumer errors must never restart a producer.
        if (!result.ok && !(attempt.outputCancellation && result.code === 'CANCELLED'))
          this.#fail(attempt, 'OUTPUT_FAILED', false)
      })
      let readinessTask: Promise<void> = Promise.resolve()
      try {
        await launch.started
        if (this.#clock.now() >= attempt.deadline && !attempt.ending)
          this.#fail(attempt, 'STARTUP_TIMEOUT', true, 'timed-out')
        if (!attempt.ending) {
          if (this.#readiness) {
            const readiness = this.#readiness
            readinessTask = (async () => {
              try {
                const ready = await readiness(context)
                if (attempt.ending) return
                if (this.#clock.now() >= attempt.deadline)
                  this.#fail(attempt, 'STARTUP_TIMEOUT', true, 'timed-out')
                else if (ready === true) {
                  this.#clearTimer()
                  this.#update({ state: 'ready', readiness: 'handshake' })
                } else this.#fail(attempt, 'READINESS_FAILED', true, 'rejected')
              } catch {
                if (!attempt.ending) this.#fail(attempt, 'READINESS_FAILED', true, 'rejected')
              }
            })()
          } else {
            this.#clearTimer()
            this.#update({ state: 'ready', readiness: 'driver-attached' })
          }
        }
      } catch {
        if (!attempt.ending) this.#fail(attempt, 'SPAWN_FAILED', false)
      }
      // Neither a timeout nor cancellation can manufacture callback or driver release.
      await Promise.all([
        processDone,
        terminalDone,
        outputDone,
        observation.released,
        readinessTask,
      ])
    } catch {
      this.#fail(attempt, 'OUTPUT_FACTORY_FAILED', false)
    } finally {
      await this.#releaseAttempt(attempt, disposeOutput, unknownOutput)
    }
  }
  async #releaseAttempt(
    attempt: Attempt,
    disposeOutput: (() => void | Promise<void>) | undefined,
    unknownOutput: boolean
  ): Promise<void> {
    this.#clearTimer()
    if (unknownOutput) return // Invalid acquired output has no proven disposal path.
    try {
      await disposeOutput?.()
    } catch {
      this.#fail(attempt, 'OUTPUT_DISPOSE_FAILED', false)
      return // Unknown consumer cleanup retains the generation; no replacement or fabricated settlement.
    }
    delete attempt.outputLease
    this.#update({ cleanupPending: true })
    // An asynchronous observer has bounded storage and cannot overlap replacement.
    await this.#waitObserver()
    this.#attempt = undefined
    this.#snapshot = Object.freeze({ ...this.#snapshot, cleanupPending: false })
    if (this.#retired) {
      this.#update({ state: 'stopped' })
      this.#finish()
    } else if (attempt.failed && attempt.retry && this.#policy.mode === 'on-failure')
      this.#backoff()
    else {
      this.#update({ state: attempt.failed ? 'failed' : 'stopped' })
      this.#finish()
    }
  }
  #backoff(): void {
    if (this.#policy.mode !== 'on-failure') return
    if (this.#snapshot.attempts >= this.#policy.maxAttempts) {
      this.#update({ state: 'failed', failure: 'ATTEMPTS_EXHAUSTED' })
      this.#finish()
      return
    }
    const delay = Math.min(
      this.#policy.maxBackoffMs,
      this.#policy.initialBackoffMs * 2 ** (this.#snapshot.attempts - 1)
    )
    const at = this.#clock.now() + delay
    if (at >= this.#restartDeadline) {
      this.#update({ state: 'failed', failure: 'RESTART_DEADLINE' })
      this.#finish()
      return
    }
    this.#update({ state: 'backoff', nextAttemptAt: at })
    if (this.#retired) return
    this.#arm(at, () => {
      if (this.#retired) return
      if (this.#clock.now() >= this.#restartDeadline) {
        this.#update({ state: 'failed', failure: 'RESTART_DEADLINE', nextAttemptAt: null })
        this.#finish()
      } else
        void this.#waitObserver().then(() => {
          if (this.#retired) return
          if (this.#clock.now() >= this.#restartDeadline) {
            this.#update({ state: 'failed', failure: 'RESTART_DEADLINE', nextAttemptAt: null })
            this.#finish()
          } else this.#begin()
        })
    })
  }
  #arm(deadline: number, callback: () => void): void {
    this.#clearTimer()
    const epoch = this.#timerEpoch
    const fire = () => {
      if (epoch !== this.#timerEpoch) return
      if (this.#clock.now() < deadline) {
        this.#timer = this.#clock.set(deadline - this.#clock.now(), fire)
        return
      }
      this.#timer = undefined
      callback()
    }
    this.#timer = this.#clock.set(Math.max(0, deadline - this.#clock.now()), fire)
  }
  #clearTimer(): void {
    ++this.#timerEpoch
    if (this.#timer !== undefined) this.#clock.clear(this.#timer)
    this.#timer = undefined
  }
  #update(change: Partial<ServiceSnapshot>): void {
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...change })
    if (!this.#observer) return
    if (this.#observerBusy) {
      this.#queuedSnapshot = this.#snapshot
      return
    }
    this.#notify(this.#snapshot)
  }
  #notify(snapshot: ServiceSnapshot): void {
    if (!this.#observer) return
    if (!this.#observerBusy)
      this.#observerIdle = new Promise((resolve) => {
        this.#observerWait = resolve
      })
    this.#observerBusy = true
    let result: void | Promise<void> = undefined
    try {
      result = this.#observer(snapshot)
    } catch {
      this.#observerFailures++
    }
    void Promise.resolve(result)
      .catch(() => {
        this.#observerFailures++
      })
      .then(() => {
        const queued = this.#queuedSnapshot
        this.#queuedSnapshot = undefined
        if (queued && this.#observer) this.#notify(queued)
        else {
          this.#observerBusy = false
          const resolve = this.#observerWait
          this.#observerWait = undefined
          resolve?.()
        }
      })
  }
  #waitObserver(): Promise<void> {
    return this.#observerIdle
  }
  #detachAbort(): void {
    const remove = this.#removeAbort
    this.#removeAbort = () => {}
    remove()
  }
  #finish(): void {
    this.#retired = true
    this.#clearTimer()
    this.#detachAbort()
    this.#factory = undefined
    this.#readiness = undefined
    if (!this.#settled) {
      this.#settled = true
      void this.#waitObserver().then(() => {
        this.#observer = undefined
        this.#queuedSnapshot = undefined
        this.#resolveSettled(this.#snapshot)
      })
    }
  }
}
