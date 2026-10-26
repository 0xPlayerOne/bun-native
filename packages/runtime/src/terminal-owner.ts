import { closeSync, writeSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { constants } from 'node:os'
import {
  TerminalError,
  type TerminalDriver,
  type TerminalDriverObserver,
  type TerminalDriverProcess,
  type TerminalDriverSpawnOptions,
} from './terminal.ts'

// Shared across every driver in this backend, including independent services.
const MAX_OWNERS = 64
let owners = 0

/** Opt-in Unix native ownership. The path must name the matching prebuilt owner. */
export class NativeTerminalDriver implements TerminalDriver {
  readonly #executable: string
  constructor(executable: string) {
    if (process.platform !== 'darwin' && process.platform !== 'linux')
      throw new TerminalError('INVALID_ARGUMENT', 'Native terminal ownership is Unix-only')
    if (!isAbsolute(executable) || executable.includes('\0'))
      throw new TerminalError('INVALID_ARGUMENT', 'Owner executable must be absolute')
    this.#executable = executable
  }

  async spawn(
    options: TerminalDriverSpawnOptions,
    observer: TerminalDriverObserver
  ): Promise<TerminalDriverProcess> {
    if (owners >= MAX_OWNERS) throw new TerminalError('OVERLOADED')
    owners++
    let subprocess: ReturnType<typeof Bun.spawn>
    try {
      subprocess = Bun.spawn({
        cmd: [this.#executable, options.executable, ...options.argv],
        cwd: options.cwd,
        env: { ...options.env },
        // socket-fd transfers the parent descriptor to us. "pipe" would leave
        // Bun able to close a descriptor that our stream still owns/references.
        stdio: ['ignore', 'ignore', 'ignore', 'socket-fd'],
        terminal: {
          cols: options.cols,
          rows: options.rows,
          name: options.name,
          data(_terminal, bytes) {
            observer.output(bytes)
          },
          exit(_terminal, status) {
            observer.terminalClosed(status)
          },
        },
      })
    } catch (error) {
      owners--
      throw error
    }
    const terminal = subprocess.terminal!
    const fd = subprocess.stdio[3]!
    let closed = false
    const closeControl = () => {
      if (closed) return
      closed = true
      closeSync(fd)
    }
    let ready = false
    let failure: 'TERMINATION_DENIED' | 'SUPERVISION_FAILED' | undefined
    let exit: { exitCode: number | null; signalCode: number | null; waitError: boolean } | undefined
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const readiness = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // Admit before starting a pending fd read. Failed admission closes a lease
    // on which the owner has not launched user code.
    try {
      if (writeSync(fd, new Uint8Array([0])) !== 1) throw new Error('Owner admission failed')
    } catch {
      closeControl()
      void subprocess.exited.then(() => {
        owners--
      })
      throw new TerminalError('SPAWN_FAILED')
    }
    const read = (async () => {
      // Exactly one ready byte and one three-byte exit result are legal. This
      // bound includes fragmented/coalesced reads and rejects unsolicited data.
      const frame: number[] = []
      try {
        for await (const bytes of Bun.file(fd).stream()) {
          for (const byte of bytes) {
            if (!ready && frame.length === 0 && byte === 1) {
              ready = true
              resolveReady()
            } else {
              if (frame.length >= 3) throw new Error('Excess owner response')
              frame.push(byte)
            }
          }
        }
        if (frame.length === 2 && frame[0] === 3) {
          failure = frame[1] === 1 ? 'TERMINATION_DENIED' : 'SUPERVISION_FAILED'
          throw new Error('Owner failed')
        }
        if (!ready || frame.length !== 3 || frame[0] !== 2 || (frame[1] !== 0 && frame[1] !== 1))
          throw new Error('Incomplete owner response')
        exit = {
          exitCode: frame[1] === 0 ? frame[2]! : null,
          signalCode: frame[1] === 1 ? frame[2]! : null,
          waitError: false,
        }
      } catch {
        failure ??= 'SUPERVISION_FAILED'
        rejectReady(new TerminalError('SPAWN_FAILED'))
      } finally {
        closeControl()
      }
    })()
    // Both actual owner exit and control EOF are required. EOF alone cannot
    // release ownership or be substituted for an observed command result.
    void Promise.all([subprocess.exited, read]).then(([code]) => {
      if (!failure && code === 0 && exit) {
        owners--
        observer.processExited(exit)
      } else {
        // Retain global owner capacity as well as the service reservation when
        // the command/group lifetime was not established. A helper exit alone
        // is never an observed application-process exit.
        observer.processFailed?.(failure ?? 'SUPERVISION_FAILED')
      }
    })
    await readiness
    return Object.freeze({
      write: (bytes: Uint8Array) => terminal.write(bytes),
      resize: (cols: number, rows: number) => terminal.resize(cols, rows),
      signal: (signal: NodeJS.Signals) => {
        const value = constants.signals[signal]
        if (closed || value === undefined || writeSync(fd, new Uint8Array([value])) !== 1)
          throw new TerminalError('IO_FAILED')
      },
      closeTerminal: () => terminal.close(),
    })
  }
}
