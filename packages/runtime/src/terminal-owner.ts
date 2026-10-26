import { createServer, type Socket } from 'node:net'
import { closeSync, writeSync, readFileSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { constants } from 'node:os'
import {
  TerminalError,
  type TerminalDriver,
  type TerminalDriverObserver,
  type TerminalDriverProcess,
  type TerminalDriverSpawnOptions,
} from './terminal.ts'

const MAX_OWNERS = 64
let owners = 0
const SIGNALS = new Set<NodeJS.Signals>([
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGTERM',
  'SIGUSR1',
  'SIGUSR2',
  'SIGWINCH',
  'SIGKILL',
])
const HELLO = [66, 84, 79, 2]

/** Captured from the private native readiness channel, never a renderer request. */
export interface NativeTerminalConfiguration {
  readonly version: '0.1.0'
  readonly protocol: 2
  readonly executable: string
  readonly sha256: string
  readonly bytes: number
  readonly hostFd: number
  readonly platform: string
  readonly arch: string
}

/** Explicit non-detaching profile; unrestricted interactive job control is unsupported. */
export class NativeTerminalDriver implements TerminalDriver {
  readonly #configuration: NativeTerminalConfiguration
  constructor(configuration: NativeTerminalConfiguration, profile: 'non-detaching') {
    if (!['darwin', 'linux', 'win32'].includes(process.platform))
      throw new TerminalError('INVALID_ARGUMENT', 'Native terminal platform unsupported')
    if (
      profile !== 'non-detaching' ||
      configuration.version !== '0.1.0' ||
      configuration.protocol !== 2 ||
      !isAbsolute(configuration.executable) ||
      configuration.executable.includes('\0') ||
      !/^[a-f0-9]{64}$/.test(configuration.sha256) ||
      !Number.isSafeInteger(configuration.bytes) ||
      configuration.bytes <= 0 ||
      configuration.bytes > 128 * 1024 * 1024 ||
      !Number.isSafeInteger(configuration.hostFd) ||
      (process.platform === 'win32' ? configuration.hostFd !== -1 : configuration.hostFd < 3) ||
      configuration.platform !== process.platform ||
      configuration.arch !== process.arch
    )
      throw new TerminalError('INVALID_ARGUMENT', 'Native terminal configuration mismatch')
    this.#configuration = Object.freeze({ ...configuration })
    this.#verify()
  }

  #verify() {
    const config = this.#configuration
    const stat = lstatSync(config.executable)
    if (
      !stat.isFile() ||
      stat.size !== config.bytes ||
      createHash('sha256').update(readFileSync(config.executable)).digest('hex') !== config.sha256
    )
      throw new TerminalError('SPAWN_FAILED', 'Native terminal artifact integrity mismatch')
  }

  async spawn(
    options: TerminalDriverSpawnOptions,
    observer: TerminalDriverObserver
  ): Promise<TerminalDriverProcess> {
    this.#verify()
    if (options.signal?.aborted) throw new TerminalError('CANCELLED')
    if (owners >= MAX_OWNERS) throw new TerminalError('OVERLOADED')
    owners++
    const windows = process.platform === 'win32'
    const endpoint = windows ? `\\\\.\\pipe\\bunly-terminal-${crypto.randomUUID()}` : undefined
    let socket: Socket | undefined
    let resolveSocket!: (socket: Socket) => void
    let rejectSocket!: (error: Error) => void
    const connected = new Promise<Socket>((resolve, reject) => {
      resolveSocket = resolve
      rejectSocket = reject
    })
    void connected.catch(() => {})
    const server = windows
      ? createServer((incoming) => {
          if (socket) {
            incoming.destroy()
            return
          }
          socket = incoming
          incoming.on('error', () => fail())
          resolveSocket(incoming)
          server?.close()
        })
      : undefined
    let subprocess: ReturnType<typeof Bun.spawn>
    let fail: () => void = () => {}
    try {
      if (server)
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(endpoint!, resolve)
        })
      subprocess = Bun.spawn({
        cmd: [this.#configuration.executable, options.executable, ...options.argv],
        cwd: options.cwd,
        env: { ...options.env, ...(endpoint ? { BUNLY_TERMINAL_CONTROL: endpoint } : {}) },
        stdio: windows
          ? ['ignore', 'ignore', 'ignore']
          : ['ignore', 'ignore', 'ignore', 'socket-fd', this.#configuration.hostFd],
        terminal: {
          cols: options.cols,
          rows: options.rows,
          name: options.name,
          data(_terminal, bytes) {
            try {
              observer.output(bytes)
            } catch {
              fail()
            }
          },
          exit(_terminal, status) {
            try {
              observer.terminalClosed(status)
            } catch {
              fail()
            }
          },
        },
      })
    } catch {
      server?.close()
      socket?.destroy()
      owners--
      observer.processNotStarted?.()
      throw new TerminalError('SPAWN_FAILED')
    }
    const terminal = subprocess.terminal!
    const fd = subprocess.stdio[3]!
    const send = (bytes: Uint8Array) => {
      if (windows) {
        if (!socket || socket.destroyed || socket.writableLength >= 4096) throw new Error()
        socket.write(bytes)
      } else if (writeSync(fd, bytes) !== bytes.length) throw new Error()
    }
    let closed = false
    let admitted = false
    let noCommand = false
    let ready = false
    let failed = false
    let failure: 'TERMINATION_DENIED' | 'SUPERVISION_FAILED' = 'SUPERVISION_FAILED'
    let exit: { exitCode: number | null; signalCode: number | null; waitError: boolean } | undefined
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const readiness = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    void readiness.catch(() => {})
    const closeControl = () => {
      if (closed) return
      closed = true
      if (windows) {
        socket?.destroy()
        server?.close()
        rejectSocket(new TerminalError('SPAWN_FAILED'))
      } else {
        try {
          closeSync(fd)
        } catch {
          failed = true
        }
      }
    }
    fail = () => {
      failed = true
      rejectReady(new TerminalError('SPAWN_FAILED'))
      // Closing only this owned lease asks the guard to clean its retained group.
      // Never kill the guard after admission: doing so could orphan the command.
      closeControl()
      if (!admitted) {
        try {
          subprocess.kill('SIGKILL')
        } catch {
          /* retain until actual exit */
        }
      }
    }
    const abort = () => fail()
    const timeout = setTimeout(fail, Math.min(options.spawnTimeoutMs ?? 5000, 5000))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) fail()
    const read = (async () => {
      let hello = 0
      const frame: number[] = []
      try {
        const input = windows ? await connected : Bun.file(fd).stream()
        for await (const bytes of input) {
          for (const byte of bytes) {
            if (hello < HELLO.length) {
              if (byte !== HELLO[hello++]) throw new Error('Owner version mismatch')
              if (hello === HELLO.length) {
                if (closed) throw new Error('Admission cancelled')
                // From this point a failed write is conservatively unknown ownership.
                admitted = true
                send(new Uint8Array([0]))
              }
              continue
            }
            if (!ready && frame.length === 0 && byte === 1) {
              ready = true
              clearTimeout(timeout)
              options.signal?.removeEventListener('abort', abort)
              resolveReady()
            } else {
              if (
                frame.length >= 6 ||
                ((frame[0] === 3 || frame[0] === 4) && frame.length >= 2) ||
                (frame.length === 0 && byte !== 2 && byte !== 3 && byte !== 4)
              )
                throw new Error('Malformed owner response')
              frame.push(byte)
              if ((frame[0] === 3 || frame[0] === 4) && frame.length === 2) {
                if (frame[1] !== 1 && frame[1] !== 2) throw new Error('Invalid failure')
                failure = frame[1] === 1 ? 'TERMINATION_DENIED' : 'SUPERVISION_FAILED'
              }
            }
          }
        }
        if (!failed && frame.length === 2 && (frame[0] === 3 || frame[0] === 4)) {
          noCommand = !ready && frame[0] === 4
          throw new Error('Owner failed')
        }
        if (!ready || frame.length !== 6 || frame[0] !== 2 || (frame[1] !== 0 && frame[1] !== 1))
          throw new Error('Incomplete owner response')
        const value = new DataView(new Uint8Array(frame.slice(2)).buffer).getUint32(0, true)
        exit = {
          exitCode: frame[1] === 0 ? value : null,
          signalCode: frame[1] === 1 ? value : null,
          waitError: false,
        }
      } catch {
        fail()
      } finally {
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', abort)
        closeControl()
      }
    })()
    const notify = () => {
      try {
        if (!admitted || noCommand) observer.processNotStarted?.()
        else observer.processFailed?.(failure)
      } catch {
        /* Observers cannot reject the ownership settlement task. */
      }
    }
    void Promise.all([subprocess.exited, read]).then(
      ([code]) => {
        if (!admitted || (noCommand && code === 125)) {
          owners--
          notify()
        } else if (!failed && code === 0 && exit) {
          owners--
          try {
            observer.processExited(exit)
          } catch {
            notify()
          }
        } else {
          noCommand = false
          notify()
        }
        rejectReady(new TerminalError('SPAWN_FAILED'))
      },
      () => {
        fail()
        notify()
      }
    )
    await readiness
    return Object.freeze({
      write: (bytes: Uint8Array) => terminal.write(bytes),
      resize: (cols: number, rows: number) => terminal.resize(cols, rows),
      signal: (signal: NodeJS.Signals) => {
        if (!SIGNALS.has(signal) || (windows && signal !== 'SIGTERM' && signal !== 'SIGKILL'))
          throw new TerminalError('INVALID_ARGUMENT')
        const value = constants.signals[signal]
        if (closed || value === undefined) throw new TerminalError('IO_FAILED')
        try {
          send(new Uint8Array([value]))
        } catch {
          fail()
          throw new TerminalError('IO_FAILED')
        }
      },
      closeTerminal: () => terminal.close(),
    })
  }
}
