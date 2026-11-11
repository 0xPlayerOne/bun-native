import { appendFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { loadavg, platform } from 'node:os'
import { join } from 'node:path'

/**
 * Opt-in long-session mode shared by the Solid and React workspace soaks
 * (#248, #250). Without BUN_NATIVE_SOAK_SECONDS both fixtures keep their fixed
 * CI round plan unchanged.
 *
 * - BUN_NATIVE_SOAK_SECONDS: run whole rounds until this wall time has passed.
 * - BUN_NATIVE_SOAK_SAMPLE_SECONDS: take a sample at the first round boundary
 *   after each interval (default 30).
 * - BUN_NATIVE_SOAK_PACE_MS: wall time before each streamed update, so a run
 *   can follow the app's real reply/plan interval (default 0).
 * - BUN_NATIVE_SOAK_OS_INPUT=1 (Linux X11 only): each round types one prompt
 *   or task title into the focused composer with xdotool and submits it with
 *   Return, and sends wheel notches over the window.
 *
 * Samples are appended to samples.jsonl as they are taken, so a failed run
 * keeps every sample it reached.
 */
export interface SessionConfig {
  readonly seconds: number
  readonly sampleSeconds: number
  readonly paceMs: number
  readonly osInput: boolean
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  return value
}

export function sessionConfig(native: boolean): SessionConfig | undefined {
  const seconds = integer('BUN_NATIVE_SOAK_SECONDS', 0, 10, 14_400)
  if (seconds === 0) return undefined
  if (!native) throw new Error('The long-session mode needs the real native host')
  const osInput = process.env['BUN_NATIVE_SOAK_OS_INPUT'] === '1'
  if (osInput && (platform() !== 'linux' || !process.env['DISPLAY']))
    throw new Error('Long-session OS input needs a private Linux X11 display')
  return {
    seconds,
    sampleSeconds: integer('BUN_NATIVE_SOAK_SAMPLE_SECONDS', 30, 1, 600),
    paceMs: integer('BUN_NATIVE_SOAK_PACE_MS', 0, 0, 2_000),
    osInput,
  }
}

/** Find the owned native host among this process's children by executable. */
export function ownedHost(executable: string): number | undefined {
  if (platform() !== 'linux') return undefined
  const expected = realpathSync(executable)
  for (const task of readdirSync(`/proc/${process.pid}/task`)) {
    let children: string
    try {
      children = readFileSync(`/proc/${process.pid}/task/${task}/children`, 'utf8')
    } catch {
      continue
    }
    for (const child of children.split(' ').filter(Boolean)) {
      try {
        if (realpathSync(`/proc/${child}/exe`) === expected) return Number(child)
      } catch {}
    }
  }
  return undefined
}

export interface ProcessSample {
  readonly rssKiB: number
  readonly hwmKiB: number
  readonly threads: number
  readonly fds: number
  /** utime + stime in clock ticks. */
  readonly cpuTicks: number
}

/** /proc observations of one live process; null when it is not observable. */
export function processSample(pid: number | undefined): ProcessSample | null {
  if (pid === undefined || platform() !== 'linux') return null
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status)![1])
    // Fields after the parenthesised command name; utime and stime are 14 and 15.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return {
      rssKiB: field('VmRSS'),
      hwmKiB: field('VmHWM'),
      threads: field('Threads'),
      fds: readdirSync(`/proc/${pid}/fd`).length,
      cpuTicks: Number(rest[11]) + Number(rest[12]),
    }
  } catch {
    return null
  }
}

function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

export function distribution(values: readonly number[]) {
  if (values.length === 0) return { count: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const round = (value: number) => Math.round(value * 1000) / 1000
  return {
    count: sorted.length,
    p50: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    p99: round(quantile(sorted, 0.99)),
    max: round(sorted.at(-1)!),
  }
}

/** Per-interval acknowledgement and input-latency observations plus a JSONL sink. */
export class SessionRecorder {
  readonly #path: string | undefined
  #ack: number[] = []
  #input: number[] = []
  readonly allAck: number[] = []
  readonly allInput: number[] = []

  constructor(directory: string | undefined) {
    this.#path = directory === undefined ? undefined : join(directory, 'samples.jsonl')
  }

  /** Milliseconds from a component action to its native acknowledgement. */
  ack(milliseconds: number) {
    this.#ack.push(milliseconds)
    this.allAck.push(milliseconds)
  }

  /** Milliseconds from an OS input command to the app state it causes. */
  input(milliseconds: number) {
    this.#input.push(milliseconds)
    this.allInput.push(milliseconds)
  }

  /** Close the current interval and append one sample line. */
  record(sample: Record<string, unknown>): Record<string, unknown> {
    const row = {
      ...sample,
      loadAverage: loadavg(),
      ackMs: distribution(this.#ack),
      inputToStateMs: distribution(this.#input),
    }
    this.#ack = []
    this.#input = []
    if (this.#path) appendFileSync(this.#path, JSON.stringify(row) + '\n')
    return row
  }
}

function run(command: string[], timeoutMs = 10_000): string {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
  if (result.exitCode !== 0)
    throw new Error(
      `${command.slice(0, 2).join(' ')} failed (${result.exitCode}): ${result.stderr}`
    )
  return result.stdout.toString().trim()
}

/**
 * Real X11 keyboard and wheel input to the owned host window through XTest
 * (xdotool), refusing any window another process owns.
 */
export class X11Input {
  readonly window: string
  typedCharacters = 0
  keys = 0
  wheelNotches = 0

  private constructor(window: string) {
    this.window = window
  }

  static async open(title: string, hostPid: number): Promise<X11Input> {
    const until = performance.now() + 10_000
    while (performance.now() < until) {
      const found = Bun.spawnSync(['xdotool', 'search', '--onlyvisible', '--name', `^${title}$`], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      for (const candidate of found.stdout.toString().split(/\s+/).filter(Boolean)) {
        const owner = Bun.spawnSync(['xdotool', 'getwindowpid', candidate], { stdout: 'pipe' })
        if (owner.stdout.toString().trim() === String(hostPid)) {
          const input = new X11Input(candidate)
          input.activate()
          return input
        }
      }
      await Bun.sleep(50)
    }
    throw new Error(`No visible window titled ${title} owned by host ${hostPid}`)
  }

  activate() {
    run(['xdotool', 'windowactivate', '--sync', this.window])
    this.requireFocus()
  }

  requireFocus() {
    if (run(['xdotool', 'getwindowfocus']) !== this.window)
      throw new Error('The owned workspace window lost X11 focus before input')
  }

  type(text: string) {
    this.requireFocus()
    run(['xdotool', 'type', '--clearmodifiers', '--delay', '5', text])
    this.typedCharacters += text.length
  }

  key(name: string) {
    this.requireFocus()
    run(['xdotool', 'key', '--clearmodifiers', name])
    this.keys++
  }

  /** Wheel notches at a window-relative point: button 5 scrolls down, 4 up. */
  wheel(x: number, y: number, button: 4 | 5, notches: number) {
    this.requireFocus()
    run([
      'xdotool',
      'mousemove',
      '--window',
      this.window,
      String(x),
      String(y),
      'click',
      '--repeat',
      String(notches),
      '--delay',
      '10',
      String(button),
    ])
    this.wheelNotches += notches
  }

  get counts() {
    return {
      typedCharacters: this.typedCharacters,
      keys: this.keys,
      wheelNotches: this.wheelNotches,
    }
  }
}

/** Poll until the predicate holds, yielding to native events between checks. */
export async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 10_000) {
  const until = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > until) throw new Error(`Timed out waiting for ${description}`)
    await Bun.sleep(2)
  }
}
