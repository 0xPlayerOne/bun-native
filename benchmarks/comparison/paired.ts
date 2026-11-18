/**
 * ABBA-paired comparison driver (#677).
 *
 * Runs the two existing harnesses in A, B, B, A order instead of trusting one
 * block from each. A block is a full `benchmarks/comparison/run.ts` or
 * `benchmarks/electrobun/run.ts` invocation, so this adds pairing and reporting
 * without duplicating either harness's build, launch or evidence logic.
 *
 * ABBA is deliberate: with a monotonic drift over a session (thermal, page cache,
 * background load), the two A blocks bracket the two B blocks, so the mean of each
 * system's blocks cancels a linear trend instead of charging it to whichever
 * system ran later. Each launch already records `loadAverageBeforeLaunch`, so a
 * block taken under unusual load is visible rather than inferred.
 *
 * Only peak process-tree RSS is compared. Whole-launch wall time is recorded but
 * never put in a ratio: the Electrobun workload is vsync-locked, so its ~2,100
 * frame-synchronized operations take about 36 s while the Bun Native workload's
 * 1,000 updates take about 2 s. A wall-time ratio would measure frame pacing, not
 * efficiency. Startup and input timing are excluded for the same reason class —
 * an acknowledged native view and a WebView mount are different endpoints.
 *
 *   bun benchmarks/comparison/paired.ts \
 *     --bun-native 'bun benchmarks/comparison/run.ts --host /abs/host --host-profile release --trials 3 --output {output}' \
 *     --electrobun 'bun benchmarks/electrobun/run.ts --app /abs/App.app --trials 3 --output {output}' \
 *     --output /abs/new-paired-run
 *
 * Each command must contain `{output}`; the driver replaces it with a new
 * per-block directory and reads that harness's record file from it.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'

export type System = 'bun-native' | 'electrobun'

/** A, B, B, A — A brackets B so a linear drift cancels. */
export const ABBA: readonly System[] = ['bun-native', 'electrobun', 'electrobun', 'bun-native']

export type Samples = { wallMs: number[]; rssMB: number[] }

export type Comparison = {
  metric: 'processWallMs' | 'peakProcessTreeRssMB'
  bunNative: number
  electrobun: number
  /** Bun Native divided by Electrobun; below 1 means Bun Native is smaller/faster. */
  ratio: number
  meaning: string
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length

/**
 * Drift-cancelled ABBA estimate: mean of the two bun-native blocks against the
 * mean of the two electrobun blocks. Two blocks per system are required; one
 * block cannot separate the systems from the session's trend.
 */
export function abbaCompare(
  bunNative: readonly Samples[],
  electrobun: readonly Samples[],
  key: keyof Samples,
  metric: Comparison['metric'],
  meaning: string
): Comparison {
  assert.equal(bunNative.length, 2, 'ABBA needs two bun-native blocks')
  assert.equal(electrobun.length, 2, 'ABBA needs two electrobun blocks')
  const bunNativeMean = mean(bunNative.map((sample) => median(sample[key])))
  const electrobunMean = mean(electrobun.map((sample) => median(sample[key])))
  return {
    metric,
    bunNative: bunNativeMean,
    electrobun: electrobunMean,
    ratio: electrobunMean === 0 ? Number.POSITIVE_INFINITY : bunNativeMean / electrobunMean,
    meaning,
  }
}

type Launch = Record<string, unknown>

function launchesOf(record: unknown, file: string): Launch[] {
  const launches = (record as { launches?: unknown }).launches
  assert(Array.isArray(launches) && launches.length > 0, `${file} has no launches array`)
  return launches as Launch[]
}

/** Measured, passed launches from a Bun Native `comparison.json`. */
export function bunNativeSamples(record: unknown, file = 'comparison.json'): Samples {
  const measured = launchesOf(record, file).filter(
    (launch) => launch['status'] === 'passed' && launch['warmup'] !== true
  ) as unknown as { process: { wallMs: number; peakTreeRssBytes: number } }[]
  assert(measured.length > 0, `${file} has no measured passed launches`)
  return {
    wallMs: measured.map((launch) => launch.process.wallMs),
    rssMB: measured.map((launch) => launch.process.peakTreeRssBytes / 1e6),
  }
}

/** Measured, passed launches from an Electrobun `electrobun.json` (order 0 is warm-up). */
export function electrobunSamples(record: unknown, file = 'electrobun.json'): Samples {
  const measured = launchesOf(record, file).filter(
    (launch) => launch['status'] === 'passed' && launch['order'] !== 0
  ) as unknown as { wallMs: number; peakTotalRssBytes: number }[]
  assert(measured.length > 0, `${file} has no measured passed launches`)
  return {
    wallMs: measured.map((launch) => launch.wallMs),
    rssMB: measured.map((launch) => launch.peakTotalRssBytes / 1e6),
  }
}

export function blockDirectory(base: string, index: number) {
  return `${base}-block-${index}`
}

export function renderMarkdown(order: readonly System[], comparisons: readonly Comparison[]) {
  const lines = [
    '| metric | Bun Native | Electrobun | Bun Native / Electrobun |',
    '| --- | ---: | ---: | ---: |',
    ...comparisons.map(
      (item) =>
        `| ${item.metric} | ${item.bunNative.toFixed(2)} | ${item.electrobun.toFixed(2)} | ${item.ratio.toFixed(3)} |`
    ),
    '',
    `Order: ${order.join(' → ')} (means of two blocks per system)`,
    '',
    ...comparisons.map((item) => `- **${item.metric}**: ${item.meaning}`),
    '',
    'Not compared: wall time, startup and input timing. The Electrobun workload is',
    'vsync-locked, so its wall time measures frame pacing; startup and input measure',
    'different endpoints on each side. All three are recorded per block and must stay',
    'side by side rather than in a ratio.',
  ]
  return lines.join('\n') + '\n'
}

export type PairedOptions = {
  /** Absolute directory that must not exist yet; one subdirectory per block. */
  output: string
  commands: Record<System, string>
  /** Injectable for tests; runs one block and returns its exit code. */
  spawn?: (command: string) => number
}

export type PairedReport = {
  schemaVersion: number
  status: 'recorded' | 'incomplete'
  order: readonly System[]
  blocks: { index: number; system: System; directory: string; succeeded: boolean }[]
  comparisons: Comparison[]
  recordedWallMs: {
    bunNative: number[]
    electrobun: number[]
    comparable: false
    reason: string
  } | null
  notCompared: string
}

const RECORD: Record<System, string> = {
  'bun-native': 'comparison.json',
  electrobun: 'electrobun.json',
}

/**
 * Runs the ABBA blocks and builds the report. Separated from argv handling so the
 * pairing, the incomplete-block rule and the report shape are testable without
 * launching a native application.
 */
export function runPaired(options: PairedOptions): {
  report: PairedReport
  complete: boolean
} {
  const spawn =
    options.spawn ?? ((command: string) => Bun.spawnSync(['bash', '-lc', command]).exitCode)
  const samples: Record<System, Samples[]> = { 'bun-native': [], electrobun: [] }
  const blocks: PairedReport['blocks'] = []

  for (const [index, system] of ABBA.entries()) {
    const directory = blockDirectory(options.output, index)
    spawn(options.commands[system].replaceAll('{output}', directory))
    const file = join(directory, RECORD[system])
    const succeeded = existsSync(file)
    blocks.push({ index, system, directory, succeeded })
    if (!succeeded) continue
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    samples[system].push(
      system === 'bun-native' ? bunNativeSamples(parsed, file) : electrobunSamples(parsed, file)
    )
  }

  const complete = samples['bun-native'].length === 2 && samples.electrobun.length === 2
  const comparisons = complete
    ? [
        abbaCompare(
          samples['bun-native'],
          samples.electrobun,
          'rssMB',
          'peakProcessTreeRssMB',
          'peak process-tree RSS: Bun Native host plus application against the Electrobun launcher plus its WebKit helpers'
        ),
      ]
    : []
  return {
    complete,
    report: {
      schemaVersion: 1,
      status: complete ? 'recorded' : 'incomplete',
      order: ABBA,
      blocks,
      comparisons,
      // Wall time is reported per system but never compared: the workload on the
      // WebView side is frame-synchronized, so its duration is a property of vsync.
      recordedWallMs: complete
        ? {
            bunNative: samples['bun-native'].map((item) => median(item.wallMs)),
            electrobun: samples.electrobun.map((item) => median(item.wallMs)),
            comparable: false,
            reason:
              'the Electrobun workload is vsync-locked (~2,100 frame-synchronized operations), so wall time measures frame pacing rather than efficiency',
          }
        : null,
      notCompared:
        'startup and input timing are recorded per block on each side but not compared: an acknowledged native view and a WebView mount are different endpoints',
    },
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      'bun-native': { type: 'string' },
      electrobun: { type: 'string' },
      output: { type: 'string' },
    },
  })
  for (const name of ['bun-native', 'electrobun', 'output'] as const)
    assert(values[name], `--${name} is required`)
  const output = values.output!
  assert(isAbsolute(output), '--output must be absolute')
  assert(!existsSync(output), '--output must not exist yet')
  const commands: Record<System, string> = {
    'bun-native': values['bun-native']!,
    electrobun: values.electrobun!,
  }
  for (const system of ABBA)
    assert(commands[system].includes('{output}'), `--${system} must contain {output}`)

  mkdirSync(output)
  const { report, complete } = runPaired({ output, commands })
  writeFileSync(join(output, 'paired.json'), JSON.stringify(report, null, 2) + '\n')
  if (complete) writeFileSync(join(output, 'paired.md'), renderMarkdown(ABBA, report.comparisons))
  console.log(renderMarkdown(ABBA, report.comparisons))
  if (!complete) {
    console.error('an ABBA pair needs both blocks of each system; this run is incomplete')
    process.exit(1)
  }
}
