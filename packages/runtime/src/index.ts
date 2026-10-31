import {
  encodeFrame,
  FrameDecoder,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
  ProtocolError,
  type Command,
  type NativeEvent,
} from '@bun-native/protocol'
import { isAbsolute } from 'node:path'

type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never
export type WindowCommand = WithoutId<Extract<Command, { type: 'open' | 'update' | 'close' }>>
export type WindowEvent = Extract<NativeEvent, { type: 'click' | 'input' | 'closed' }>

export interface HostOptions {
  /** Explicit prebuilt executable; starting an app never invokes Cargo. */
  executable: string
  /** Optional native process arguments, passed without a shell. */
  args?: readonly string[]
  requestTimeoutMs?: number
}

type Pending = {
  expected: 'ack' | 'opened'
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type WaitingReader = {
  resolve: (value: IteratorResult<WindowEvent>) => void
  reject: (error: Error) => void
}

const MAX_PENDING_COMMANDS = 128
const MAX_QUEUED_EVENTS = 128

/**
 * Owns one native process and its bounded, versioned channel. BN0 transport API;
 * framework-specific reconciliation belongs above this shared connection.
 */
export class NativeHost implements AsyncIterable<WindowEvent> {
  readonly exited: Promise<number>
  private readonly process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private readonly timeout: number
  private readonly pending = new Map<number, Pending>()
  private readonly events: WindowEvent[] = []
  private readonly finished: Promise<void>
  private waiting: WaitingReader | undefined
  private failure: Error | undefined
  private phase: 'starting' | 'running' | 'stopping' | 'closed' = 'starting'
  private ready = false
  private nextId = 1
  private writeTail: Promise<void> = Promise.resolve()
  private stderrTail = ''
  private iteratorTaken = false

  private constructor(options: HostOptions) {
    this.timeout = options.requestTimeoutMs ?? 5_000
    this.process = Bun.spawn({
      cmd: [options.executable, ...(options.args ?? [])],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this.exited = this.process.exited
    this.finished = this.watch()
  }

  static async launch(options: HostOptions): Promise<NativeHost> {
    if (!isAbsolute(options.executable)) throw new Error('Native host path must be absolute')
    const timeout = options.requestTimeoutMs ?? 5_000
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
      throw new Error('requestTimeoutMs must be an integer between 1 and 60000')
    const host = new NativeHost(options)
    try {
      await host.request({ type: 'hello', protocol: PROTOCOL_VERSION })
      if (!host.ready) throw new ProtocolError('Host acknowledged hello before protocol readiness')
      host.phase = 'running'
      return host
    } catch (error) {
      host.fail(error)
      await host.finished
      throw host.failure
    }
  }

  /** Resolves after the native UI thread acknowledges the operation. */
  send(command: WindowCommand): Promise<void> {
    if (this.phase !== 'running') return Promise.reject(this.closedError())
    return this.request(command)
  }

  async shutdown(): Promise<void> {
    if (this.phase === 'closed' || this.phase === 'stopping') {
      await this.finished
      if (this.failure) throw this.failure
      return
    }
    this.phase = 'stopping'
    try {
      await this.request({ type: 'shutdown' })
      this.process.stdin.end()
      const deadline = setTimeout(
        () => this.fail(new Error('Native host did not exit')),
        this.timeout
      )
      try {
        await this.finished
      } finally {
        clearTimeout(deadline)
      }
      if (this.failure) throw this.failure
    } catch (error) {
      this.fail(error)
      await this.finished
      throw this.failure
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<WindowEvent> {
    if (this.iteratorTaken) throw new Error('Native events have exactly one consumer')
    this.iteratorTaken = true
    return {
      next: () => {
        if (this.failure) return Promise.reject(this.failure)
        const event = this.events.shift()
        if (event) return Promise.resolve({ done: false, value: event })
        if (this.phase === 'closed') return Promise.resolve({ done: true, value: undefined })
        if (this.waiting)
          return Promise.reject(new Error('Concurrent event reads are not supported'))
        return new Promise<IteratorResult<WindowEvent>>((resolve, reject) => {
          this.waiting = { resolve, reject }
        })
      },
      return: async () => {
        await this.shutdown()
        return { done: true, value: undefined }
      },
    }
  }

  private request(input: WithoutId<Command>): Promise<void> {
    if (this.phase === 'closed') return Promise.reject(this.closedError())
    if (this.pending.size >= MAX_PENDING_COMMANDS)
      return Promise.reject(new Error('Native command limit exceeded'))
    let command: Command
    let frame: Uint8Array
    try {
      command = parseCommand({ ...input, id: this.nextId++ })
      frame = encodeFrame(command)
    } catch (error) {
      return Promise.reject(error)
    }
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error(`Native ${command.type} request ${command.id} timed out`)),
        this.timeout
      )
      this.pending.set(command.id, {
        expected: command.type === 'open' ? 'opened' : 'ack',
        resolve,
        reject,
        timer,
      })
    })
    // FileSink buffering is bounded by the pending-command cap and frame limit.
    this.writeTail = this.writeTail
      .then(async () => {
        if (this.phase === 'closed') return
        this.process.stdin.write(frame)
        await this.process.stdin.flush()
      })
      .catch((error: unknown) => this.fail(error))
    return result
  }

  private async readStdout(): Promise<void> {
    const decoder = new FrameDecoder()
    for await (const chunk of this.process.stdout) {
      for (const raw of decoder.push(chunk)) this.receive(parseEvent(raw))
    }
    decoder.finish()
    if (this.phase !== 'stopping' && this.phase !== 'closed')
      throw new ProtocolError('Native output closed before shutdown')
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder()
    for await (const chunk of this.process.stderr)
      this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-4_096)
    this.stderrTail = (this.stderrTail + decoder.decode()).slice(-4_096)
  }

  private async watch(): Promise<void> {
    try {
      const [code] = await Promise.all([this.exited, this.readStdout(), this.readStderr()])
      if (code !== 0 || this.phase !== 'stopping' || this.pending.size)
        throw new Error(`Native host exited unexpectedly (${code}). ${this.stderrTail}`)
      this.phase = 'closed'
      this.waiting?.resolve({ done: true, value: undefined })
      this.waiting = undefined
    } catch (error) {
      this.fail(error)
      await this.exited
    }
  }

  private receive(event: NativeEvent): void {
    if (this.phase === 'closed') return
    if (event.type === 'ready') {
      if (this.ready || this.phase !== 'starting') throw new ProtocolError('Unexpected ready event')
      this.ready = true
      return
    }
    if (event.type === 'ack' || event.type === 'opened' || event.type === 'error') {
      if (event.type === 'error' && event.id === undefined)
        throw new ProtocolError(`Native ${event.code}: ${event.message}`)
      const requestId = event.id
      const request = requestId === undefined ? undefined : this.pending.get(requestId)
      if (!request || requestId === undefined) throw new ProtocolError('Unknown native response id')
      clearTimeout(request.timer)
      this.pending.delete(requestId)
      if (event.type === 'error')
        request.reject(new Error(`Native ${event.code}: ${event.message}`))
      else if (event.type !== request.expected) {
        const error = new ProtocolError('Native response type does not match its request')
        request.reject(error)
        throw error
      } else request.resolve()
      return
    }
    if (!this.ready) throw new ProtocolError('Native input arrived before protocol readiness')
    if (this.waiting) {
      this.waiting.resolve({ done: false, value: event })
      this.waiting = undefined
    } else {
      if (this.events.length >= MAX_QUEUED_EVENTS)
        throw new ProtocolError('Native event limit exceeded')
      this.events.push(event)
    }
  }

  private closedError(): Error {
    return this.failure ?? new Error('Native host is not running')
  }

  private fail(cause: unknown): void {
    if (this.failure) return
    this.failure = cause instanceof Error ? cause : new Error(String(cause))
    this.phase = 'closed'
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(this.failure)
    }
    this.pending.clear()
    this.events.length = 0
    this.waiting?.reject(this.failure)
    this.waiting = undefined
    this.process.kill('SIGKILL')
  }
}
