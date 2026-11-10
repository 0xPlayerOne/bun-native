import type { NativeProcess, ProcessEvent } from '@bun-native/core'

/** Lines kept in the terminal's scrollback; older lines are dropped. */
export const MAX_TERMINAL_LINES = 200
/** Characters kept per line; a longer line is cut. */
export const MAX_TERMINAL_COLUMNS = 400
/** Characters accepted for one command. */
export const MAX_COMMAND_LENGTH = 240

export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'failed' | 'released'

export interface TerminalLine {
  /** Stable identity for keyed rendering; increases monotonically. */
  readonly id: number
  readonly text: string
}

export interface TerminalState {
  readonly status: TerminalStatus
  readonly lines: readonly TerminalLine[]
  /** The line being written, without a trailing newline yet. */
  readonly partial: string
  /** Exit code or signal name once the shell has exited, or the start error. */
  readonly detail: string
}

export type TerminalSpawn = (
  listener: (event: ProcessEvent) => void | Promise<void>
) => Promise<NativeProcess>

// CSI and OSC sequences, and other two-byte escapes. A plain-text view shows
// their effect on neither colour nor cursor, so they are removed.
// oxlint-disable-next-line no-control-regex
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g
// Windows' pseudo console positions the cursor on a new row instead of
// writing a newline; a plain-text view ends the line there.
// oxlint-disable-next-line no-control-regex
const ROW_MOVES = /\u001b\[[0-9;]*[EFHf]/g
// oxlint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f]/g

/**
 * One owned shell on a pseudo-terminal, shown as plain text. Each start
 * creates a new process generation; output or an exit from an earlier
 * generation is ignored. `release` stops the shell's whole process group.
 */
export class TerminalSession {
  private state: TerminalState = { status: 'idle', lines: [], partial: '', detail: '' }
  private process: NativeProcess | undefined
  private generation = 0
  private nextLine = 1
  /** Undisplayed tail of the output, kept raw so a split escape still matches. */
  private pending = ''
  private decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()
  private readonly listeners = new Set<(state: TerminalState) => void>()

  constructor(private readonly spawn: TerminalSpawn) {}

  get current(): TerminalState {
    return this.state
  }

  subscribe(listener: (state: TerminalState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Starts a shell unless one is starting or running. */
  async start(): Promise<void> {
    if (this.state.status === 'starting' || this.state.status === 'running') return
    if (this.state.status === 'released') throw new Error('Terminal session was released')
    const generation = ++this.generation
    this.decoder = new TextDecoder()
    this.pending = ''
    this.publish({ status: 'starting', partial: '', detail: '' })
    let child: NativeProcess
    try {
      child = await this.spawn((event) => this.deliver(generation, event))
    } catch (error) {
      if (generation === this.generation && this.status() === 'starting')
        this.publish({ status: 'failed', detail: (error as Error).message })
      return
    }
    if (generation !== this.generation || this.status() !== 'starting') {
      await child.release()
      return
    }
    this.process = child
    // The exit can arrive before spawn resolves; it already ended the session.
    if (child.exit === undefined) this.publish({ status: 'running' })
  }

  /** Sends one command line. Returns false when no shell is running or the command is invalid. */
  async run(command: string): Promise<boolean> {
    const line = command.replace(/[\r\n]+$/u, '')
    if (
      this.state.status !== 'running' ||
      !this.process ||
      line.length > MAX_COMMAND_LENGTH ||
      /[\r\n]/u.test(line)
    )
      return false
    await this.process.write(this.encoder.encode(line + '\r'))
    return true
  }

  /**
   * Types Ctrl-C. The terminal turns it into an interrupt for the foreground
   * job, which an interactive shell runs in its own process group; signalling
   * the shell's group would reach only the shell, which ignores it.
   */
  async interrupt(): Promise<boolean> {
    if (this.state.status !== 'running' || !this.process) return false
    await this.process.write(this.encoder.encode('\u0003'))
    return true
  }

  /** Stops the current shell and starts a new one, keeping the scrollback. */
  async restart(): Promise<void> {
    if (this.state.status === 'released') return
    await this.stop()
    await this.start()
  }

  /** Idempotent. Stops the shell and refuses later starts. */
  async release(): Promise<void> {
    if (this.state.status === 'released') return
    await this.stop()
    this.publish({ status: 'released' })
    this.listeners.clear()
  }

  private async stop(): Promise<void> {
    this.generation++
    const child = this.process
    this.process = undefined
    if (this.state.status === 'starting' || this.state.status === 'running')
      this.publish({ status: 'idle', detail: '' })
    await child?.release()
  }

  private deliver(generation: number, event: ProcessEvent): Promise<void> | undefined {
    if (generation !== this.generation) return undefined
    if (event.type === 'process_output') {
      this.append(this.decoder.decode(event.bytes, { stream: true }))
      return undefined
    }
    this.append(this.decoder.decode())
    const exit = event.exit
    this.process = undefined
    this.publish({
      status: 'exited',
      detail: 'signal' in exit ? 'signal ' + String(exit.signal) : 'exit ' + String(exit.code),
    })
    // An exited process stays owned until released.
    return event.process.release()
  }

  private append(chunk: string): void {
    if (!chunk) return
    const parts = (this.pending + chunk).replace(ROW_MOVES, '\n').split('\n')
    // A tail without a newline (such as a prompt) is shown but kept raw.
    this.pending = (parts.pop() ?? '').slice(-MAX_TERMINAL_COLUMNS * 4)
    const lines = [...this.state.lines]
    for (const part of parts) lines.push({ id: this.nextLine++, text: clean(part) })
    if (lines.length > MAX_TERMINAL_LINES) lines.splice(0, lines.length - MAX_TERMINAL_LINES)
    this.publish({ lines, partial: clean(this.pending) })
  }

  /** Read through a call so a narrowing from before an await does not stick. */
  private status(): TerminalStatus {
    return this.state.status
  }

  private publish(change: Partial<TerminalState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener(this.state)
  }
}

/** Applies carriage returns (the last overwrite wins) and drops other controls. */
function clean(line: string): string {
  const visible = line
    .replace(ESCAPES, '')
    .split('\r')
    .reduce((shown, segment) => {
      return segment.length >= shown.length ? segment : segment + shown.slice(segment.length)
    }, '')
  return visible.replace(CONTROLS, '').slice(0, MAX_TERMINAL_COLUMNS)
}
