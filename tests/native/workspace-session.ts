import {
  appendFileSync,
  existsSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { loadavg, platform } from 'node:os'
import { isAbsolute, join } from 'node:path'

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
 * - BUN_NATIVE_SOAK_OS_INPUT=1: each round types one prompt or task title
 *   into the focused composer and submits it with Return, and sends wheel
 *   notches over a scroll container. Linux uses XTest (xdotool) on a private
 *   X11 display; macOS uses the bounded CoreGraphics helper named by
 *   BUN_NATIVE_PLATFORM_HELPER (scripts/quality/native-platform-macos.m),
 *   which verifies the owned window and foreground before every post.
 * - BUN_NATIVE_SOAK_HEAP_CENSUS=1: each sample also records JSC's live
 *   object count per type after the forced collection, and writes
 *   strings-<round>.json with every live string's text and count, taken from
 *   a heap snapshot, to attribute growth.
 *
 * Samples are appended to samples.jsonl as they are taken, so a failed run
 * keeps every sample it reached.
 */
export interface SessionConfig {
  readonly seconds: number
  readonly sampleSeconds: number
  readonly paceMs: number
  readonly osInput: boolean
  readonly census: boolean
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
  if (osInput && platform() === 'darwin') {
    const helper = process.env['BUN_NATIVE_PLATFORM_HELPER']
    if (!helper || !isAbsolute(helper) || !existsSync(helper))
      throw new Error('macOS long-session input needs an absolute BUN_NATIVE_PLATFORM_HELPER')
  } else if (osInput && (platform() !== 'linux' || !process.env['DISPLAY']))
    throw new Error('Long-session OS input needs a private Linux X11 display or macOS')
  return {
    seconds,
    sampleSeconds: integer('BUN_NATIVE_SOAK_SAMPLE_SECONDS', 30, 1, 600),
    paceMs: integer('BUN_NATIVE_SOAK_PACE_MS', 0, 0, 2_000),
    osInput,
    census: process.env['BUN_NATIVE_SOAK_HEAP_CENSUS'] === '1',
  }
}

/** Count every live string in a heap snapshot by its text (census mode). */
export function writeStringCensus(directory: string, round: number) {
  const snapshot = JSON.parse(Bun.generateHeapSnapshot('v8')) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[]] } }
    nodes: number[]
    strings: string[]
  }
  const fields = snapshot.snapshot.meta.node_fields
  const typeField = fields.indexOf('type')
  const nameField = fields.indexOf('name')
  const stringType = snapshot.snapshot.meta.node_types[0].indexOf('string')
  const counts = new Map<string, number>()
  for (let node = 0; node < snapshot.nodes.length; node += fields.length) {
    if (snapshot.nodes[node + typeField] !== stringType) continue
    const text = snapshot.strings[snapshot.nodes[node + nameField]!]!
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  writeFileSync(
    join(directory, `strings-${round}.json`),
    JSON.stringify(Object.fromEntries(counts))
  )
}

/** Find the owned native host among this process's children by executable. */
export function ownedHost(executable: string): number | undefined {
  const expected = realpathSync(executable)
  if (platform() === 'darwin') {
    const children = Bun.spawnSync(['pgrep', '-P', String(process.pid)], { stdout: 'pipe' })
    for (const child of children.stdout.toString().split(/\s+/).filter(Boolean)) {
      const command = Bun.spawnSync(['ps', '-o', 'comm=', '-p', child], { stdout: 'pipe' })
      try {
        if (realpathSync(command.stdout.toString().trim()) === expected) return Number(child)
      } catch {}
    }
    return undefined
  }
  if (platform() !== 'linux') return undefined
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
  /** Peak RSS; Linux only (null on macOS). */
  readonly hwmKiB: number | null
  readonly threads: number
  readonly fds: number
  /** User plus system CPU time in 1/100 s (Linux USER_HZ clock ticks). */
  readonly cpuTicks: number
}

/** Seconds from a macOS `ps -o time=` field, printed as [[dd-]hh:]mm:ss.cc. */
export function psCpuSeconds(time: string): number {
  const parts = time.trim().replace('-', ':').split(':')
  if (parts.length < 2 || parts.length > 4 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part)))
    throw new Error(`Unexpected ps CPU time: ${time}`)
  const scales = [1, 60, 3600, 86_400]
  return parts.reduce(
    (total, part, index) => total + Number(part) * scales[parts.length - 1 - index]!,
    0
  )
}

function macProcessSample(pid: number): ProcessSample | null {
  const text = (command: string[]) =>
    Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' }).stdout.toString()
  const [rss, time] = text(['ps', '-o', 'rss=,time=', '-p', String(pid)])
    .trim()
    .split(/\s+/)
  if (!rss || !time) return null
  const seconds = psCpuSeconds(time)
  // ps -M prints a header and one line per thread.
  const threads =
    text(['ps', '-M', '-p', String(pid)])
      .trim()
      .split('\n').length - 1
  const fds = text(['lsof', '-n', '-P', '-p', String(pid), '-F', 'f'])
    .split('\n')
    .filter((line) => /^f\d+$/.test(line)).length
  return {
    rssKiB: Number(rss),
    hwmKiB: null,
    threads,
    fds,
    cpuTicks: Math.round(seconds * 100),
  }
}

/** /proc (Linux) or ps/lsof (macOS) observations; null when not observable. */
export function processSample(pid: number | undefined): ProcessSample | null {
  if (pid === undefined) return null
  if (platform() === 'darwin') return macProcessSample(pid)
  if (platform() !== 'linux') return null
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

/**
 * Fixed-memory latency histogram: 10 µs buckets up to 1 s, plus a count and
 * maximum of anything slower. A whole-session distribution must not grow the
 * heap it is observing.
 */
export class LatencyHistogram {
  static readonly #RESOLUTION_MS = 0.01
  static readonly #BUCKETS = 100_000
  readonly #counts = new Uint32Array(LatencyHistogram.#BUCKETS)
  #count = 0
  #slower = 0
  #max = 0

  add(milliseconds: number) {
    this.#count++
    this.#max = Math.max(this.#max, milliseconds)
    const bucket = Math.floor(milliseconds / LatencyHistogram.#RESOLUTION_MS)
    if (bucket >= LatencyHistogram.#BUCKETS) this.#slower++
    else this.#counts[Math.max(0, bucket)]!++
  }

  /** Nearest-rank tails at bucket resolution (upper bucket edge). */
  summary() {
    if (this.#count === 0) return { count: 0 }
    const round = (value: number) => Math.round(value * 1000) / 1000
    const at = (q: number) => {
      const wanted = Math.min(this.#count - 1, Math.floor(q * this.#count))
      let seen = 0
      for (let bucket = 0; bucket < this.#counts.length; bucket++) {
        seen += this.#counts[bucket]!
        if (seen > wanted) return round((bucket + 1) * LatencyHistogram.#RESOLUTION_MS)
      }
      return round(this.#max)
    }
    return {
      count: this.#count,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: round(this.#max),
      slowerThan1sCount: this.#slower,
    }
  }
}

/**
 * Per-interval acknowledgement and input-latency observations. Samples and
 * round durations go to samples.jsonl and rounds.txt as they are taken, so a
 * failed run keeps them and a long session does not retain them in the heap
 * it samples; the whole-session latency distributions are fixed-size
 * histograms.
 */
export class SessionRecorder {
  readonly #directory: string | undefined
  #ack: number[] = []
  #input: number[] = []
  readonly ackTotal = new LatencyHistogram()
  readonly inputTotal = new LatencyHistogram()

  constructor(directory: string | undefined) {
    this.#directory = directory
  }

  /** Milliseconds from a component action to its native acknowledgement. */
  ack(milliseconds: number) {
    this.#ack.push(milliseconds)
    this.ackTotal.add(milliseconds)
  }

  /** Milliseconds from an OS input command to the app state it causes. */
  input(milliseconds: number) {
    this.#input.push(milliseconds)
    this.inputTotal.add(milliseconds)
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
    if (this.#directory)
      appendFileSync(join(this.#directory, 'samples.jsonl'), JSON.stringify(row) + '\n')
    return row
  }

  /** Append one round's duration to rounds.txt. */
  round(milliseconds: number) {
    appendFileSync(join(this.#directory!, 'rounds.txt'), `${milliseconds}\n`)
  }

  readSamples(): Array<Record<string, unknown>> {
    return readFileSync(join(this.#directory!, 'samples.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }

  readRounds(): number[] {
    return readFileSync(join(this.#directory!, 'rounds.txt'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(Number)
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
