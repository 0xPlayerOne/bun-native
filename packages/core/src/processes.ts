import {
  MAX_PROCESS_ARGS,
  MAX_PROCESS_ENV,
  parseProcessLaunch,
  PROCESS_SIGNALS,
  type ProcessExit,
  type ProcessLaunch,
  type ProcessSignal,
  type ProcessStream,
  type TerminalSize,
} from '@bun-native/protocol'
import type { NativeFileGrant } from './files.ts'
import type { Listener } from './types.ts'

export interface ProcessOptions {
  /** Explicit argument vector after the executable; never parsed by a shell. */
  readonly args?: readonly string[]
  /** The complete environment. Nothing is inherited from the native host. */
  readonly env?: Readonly<Record<string, string>>
  /** A directory inside a live grant owned by the same window. */
  readonly cwd?: Readonly<{ grant: NativeFileGrant; path?: string }>
  /** One pseudo-terminal for all three standard streams instead of pipes. */
  readonly terminal?: Readonly<TerminalSize>
}

export type NativeProcessExit = Readonly<ProcessExit>

export type ProcessEvent =
  | Readonly<{
      type: 'process_output'
      sequence: number
      process: NativeProcess
      /** `terminal` for a pseudo-terminal process; otherwise `stdout` or `stderr`. */
      stream: ProcessStream
      /** At most 16384 bytes. The next chunk is not delivered until this callback settles. */
      bytes: Uint8Array
      signal: AbortSignal
    }>
  | Readonly<{
      type: 'process_exited'
      sequence: number
      process: NativeProcess
      /** The direct child's status. Its process group was stopped and all output delivered. */
      exit: NativeProcessExit
      signal: AbortSignal
    }>

/**
 * One child process started from a launch-policy executable. It belongs to
 * its window: closing the window or the application stops its process group.
 */
export interface NativeProcess {
  readonly executable: string
  readonly terminal: boolean
  /** False once released or revoked. An exited process stays active until released. */
  readonly active: boolean
  /** Undefined until the exit event has been delivered. */
  readonly exit: NativeProcessExit | undefined
  /** Writes at most 16384 bytes to standard input or the terminal. */
  write(bytes: Uint8Array): Promise<void>
  /** Closes standard input; on a terminal, sends end-of-file. */
  closeInput(): Promise<void>
  resize(size: TerminalSize): Promise<void>
  /** Signals the whole process group. */
  signal(signal: ProcessSignal): Promise<void>
  /** Idempotent. Stops delivery, kills the process group and reaps it. */
  release(): Promise<void>
}

export type ProcessCall =
  | { type: 'write_process'; data: string }
  | { type: 'close_process_input' }
  | { type: 'resize_process'; size: TerminalSize }
  | { type: 'signal_process'; signal: ProcessSignal }

const OPTION_KEYS = ['args', 'env', 'cwd', 'terminal']

/** Validates everything but the grant, which the window resolves. */
export function processRequest(
  executable: unknown,
  options: ProcessOptions
): { launch: Omit<ProcessLaunch, 'cwd'>; cwd?: { grant: NativeFileGrant; path: string } } {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Process options must be an object')
  if (Object.keys(options).some((key) => !OPTION_KEYS.includes(key)))
    throw new TypeError('Unknown process option')
  const { args = [], env = {}, cwd, terminal } = options
  if (!Array.isArray(args) || args.length > MAX_PROCESS_ARGS)
    throw new TypeError('Process args must be an array of at most ' + MAX_PROCESS_ARGS + ' strings')
  if (!env || typeof env !== 'object' || Array.isArray(env))
    throw new TypeError('Process env must be an object of strings')
  if (Object.keys(env).length > MAX_PROCESS_ENV)
    throw new TypeError('At most ' + MAX_PROCESS_ENV + ' environment variables may be set')
  let directory: { grant: NativeFileGrant; path: string } | undefined
  if (cwd !== undefined) {
    if (
      !cwd ||
      typeof cwd !== 'object' ||
      Object.keys(cwd).some((key) => key !== 'grant' && key !== 'path')
    )
      throw new TypeError('Process cwd must be { grant, path? }')
    directory = { grant: cwd.grant, path: cwd.path ?? '' }
  }
  try {
    const launch = parseProcessLaunch({
      executable,
      args: [...args],
      env: { ...env },
      ...(directory ? { cwd: { grant_id: 1, path: directory.path } } : {}),
      ...(terminal === undefined ? {} : { terminal: { ...terminal } }),
    })
    delete launch.cwd
    return directory ? { launch, cwd: directory } : { launch }
  } catch (error) {
    throw new TypeError((error as Error).message)
  }
}

function processCall(name: string, value: unknown): ProcessCall {
  switch (name) {
    case 'write':
      if (!(value instanceof Uint8Array)) throw new TypeError('Process input must be a Uint8Array')
      if (value.byteLength === 0 || value.byteLength > 16_384)
        throw new TypeError('Process input must be 1 to 16384 bytes; write in chunks')
      return { type: 'write_process', data: value.toBase64() }
    case 'resize': {
      const size = value as TerminalSize
      if (
        !size ||
        typeof size !== 'object' ||
        Object.keys(size).some((key) => key !== 'columns' && key !== 'rows') ||
        ![size.columns, size.rows].every(
          (item) => Number.isInteger(item) && item >= 1 && item <= 1_000
        )
      )
        throw new TypeError('Terminal size must be { columns, rows } between 1 and 1000')
      return { type: 'resize_process', size: { columns: size.columns, rows: size.rows } }
    }
    case 'signal':
      if (!PROCESS_SIGNALS.includes(value as ProcessSignal))
        throw new TypeError('Process signal must be one of ' + PROCESS_SIGNALS.join(', '))
      return { type: 'signal_process', signal: value as ProcessSignal }
    default:
      return { type: 'close_process_input' }
  }
}

/** Internal registry entry. Consumers only receive its frozen handle. */
export class ProcessRegistration {
  readonly handle: NativeProcess
  readonly controller = new AbortController()
  listener: Listener<ProcessEvent> | undefined
  exit: NativeProcessExit | undefined
  /** The highest output chunk received from the host. */
  chunk = 0
  private revoked = false
  private exited = false
  private releasing: Promise<void> | undefined

  constructor(
    readonly id: number,
    readonly windowId: number,
    executable: string,
    terminal: boolean,
    listener: Listener<ProcessEvent>,
    call: (registration: ProcessRegistration, request: ProcessCall) => Promise<void>,
    release: (registration: ProcessRegistration) => Promise<void>
  ) {
    this.listener = listener
    const run = (name: string, value?: unknown) => {
      try {
        return call(this, processCall(name, value))
      } catch (error) {
        return Promise.reject(error)
      }
    }
    const live = () => this.live
    const exit = () => this.exit
    this.handle = Object.freeze({
      executable,
      terminal,
      get active() {
        return live()
      },
      get exit() {
        return exit()
      },
      write: (bytes: Uint8Array) => run('write', bytes),
      closeInput: () => run('close'),
      resize: (size: TerminalSize) => run('resize', size),
      signal: (signal: ProcessSignal) => run('signal', signal),
      release: () => {
        this.releasing ??= this.revoked ? Promise.resolve() : release(this)
        return this.releasing
      },
    })
  }

  get live(): boolean {
    return !this.revoked
  }

  /** True after the host reported the exit; no further output follows. */
  get ended(): boolean {
    return this.exited
  }

  end(): void {
    this.exited = true
  }

  /** Synchronous local revocation; the native group is stopped separately. */
  revoke(): void {
    this.revoked = true
    this.listener = undefined
    this.controller.abort()
  }
}
