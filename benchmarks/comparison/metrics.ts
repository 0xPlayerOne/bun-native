#!/usr/bin/env bun
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  compare,
  failed,
  parseMetrics,
  summary,
  type Metric,
  type MetricsFile,
} from '../../scripts/quality/regression-check.ts'
import { perLaunch, type Launch } from './stats.ts'

/**
 * Connects recorded benchmark runs to the regression gate (#259).
 *
 *   bun benchmarks/comparison/metrics.ts export EXPORT_DIR --output FILE [--streaming RESULT.json ...]
 *   bun benchmarks/comparison/metrics.ts gate CURRENT.json BASELINE_DIR [--threshold 0.10]
 *
 * `export` turns one exported comparison (`comparison.json`, `launches.jsonl.gz`,
 * optional `input-launches.jsonl.gz`) and, optionally, streaming-list soak
 * results from the same runner into the metrics-file shape read by
 * `scripts/quality/regression-check.ts`. Every sample is one fresh process:
 * warmup and failed launches never become samples, and pooled operation
 * samples are not treated as independent.
 *
 * `gate` picks the committed baseline whose environment label is identical to
 * the current one. With none, it says so and how to adopt one, and exits 0:
 * a new runner CPU is not a regression, and hardware is never mixed. With one,
 * it runs the regression gate and exits 1 on a stable regression or a missing
 * metric.
 */

const REPRODUCE =
  'gh workflow run benchmark-comparison.yml (local: benchmarks/comparison/README.md "Run")'

/** Per-launch comparison metrics that enter the gate, with their scale. */
const LAUNCH_METRICS = [
  ['spawnToViewMountedMs', 'ms', 1],
  ['processWallMs', 'ms', 1],
  ['cpuTimeMs', 'ms', 1],
  ['peakTreeRssBytes', 'MB', 1e-6],
  ['peakApplicationRssBytes', 'MB', 1e-6],
  ['lifecycleMedianMs', 'ms', 1],
  ['signalsAcknowledgementMedianMs', 'ms', 1],
] as const

type Comparison = {
  schemaVersion: number
  status: string
  source?: { commit?: string }
  methodology?: { measuredTrials?: number }
  target: {
    os: string
    osRelease: string
    architecture: string
    cpuModels: string[]
    logicalCpus: number
  }
  displayRequest?: { vulkanDriverFiles?: string | null }
  launches: Omit<Launch, 'report'>[]
  inputLaunches?: {
    name: string
    adapter: string
    mode: string
    status: string
    commandStartToPaintObservedMs: number | null
  }[]
}

type StreamingResult = {
  status: string
  framework: string
  mode: string
  application: { stream: { updateToAck: { p50Ms: number | null; p95Ms: number | null } } }
  measurements: {
    frames: {
      intervalMs: { p95: number | null }
      renderToPaintMs: { p95: number | null }
    }
    processes: Record<'host' | 'application', { rssBytes: { max: number } | null }>
  }
}

/**
 * Hardware, OS and renderer identity. Cold-cache runs get their own label so
 * warm and cold samples are never compared.
 */
export function environmentLabel(comparison: Comparison): string {
  const { target } = comparison
  if (!target?.os || !target.architecture || !target.cpuModels?.length)
    throw new Error('comparison.json lacks the target environment')
  const renderer = comparison.displayRequest?.vulkanDriverFiles?.includes('lvp')
    ? 'llvmpipe'
    : 'gpu'
  const cold = comparison.launches.some((launch) => launch.process.pageCacheDropped)
  return [
    `${target.os}-${target.architecture}`,
    target.osRelease,
    `${target.logicalCpus} cpu`,
    [...new Set(target.cpuModels)].join(' + '),
    renderer,
    cold ? 'cold-cache' : 'warm-cache',
  ].join(' | ')
}

function readJsonl(path: string): Record<string, unknown>[] {
  return gunzipSync(readFileSync(path))
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function add(metrics: Record<string, Metric>, name: string, unit: string, value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  metrics[name] ??= { unit, direction: 'lower', samples: [], reproduce: REPRODUCE }
  metrics[name].samples.push(value)
}

/** Metrics of one exported comparison directory. */
export function fromComparison(
  comparison: Comparison,
  reports: ReadonlyMap<string, Record<string, unknown> | null>
): Record<string, Metric> {
  if (comparison.schemaVersion !== 1) throw new Error('Unsupported comparison schemaVersion')
  const metrics: Record<string, Metric> = {}
  for (const launch of comparison.launches) {
    if (launch.warmup || launch.status !== 'passed') continue
    const report = reports.get(launch.name)
    if (!report) throw new Error(`Passed launch ${launch.name} has no retained child report`)
    const values = perLaunch({ ...launch, report })
    for (const [key, unit, scale] of LAUNCH_METRICS) {
      const value = values[key]
      const name = scale === 1 ? key : key.replace(/Bytes$/, unit)
      // A passed measured launch carries every metric; a missing one fails
      // closed so a group can never be gated on fewer samples than it ran.
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`Passed launch ${launch.name} lacks ${name}`)
      add(metrics, `${launch.adapter}/${launch.mode} ${name}`, unit, value * scale)
    }
  }
  for (const launch of comparison.inputLaunches ?? []) {
    if (launch.status !== 'passed') continue
    const value = launch.commandStartToPaintObservedMs
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(
        `Passed input launch ${launch.adapter}/${launch.mode} lacks commandStartToPaintObservedMs`
      )
    add(metrics, `${launch.adapter}/${launch.mode} clickToPaintMs`, 'ms', value)
  }
  return metrics
}

/** Metrics of streaming-list soak results; each result is one fresh launch. */
export function fromStreaming(results: readonly StreamingResult[]): Record<string, Metric> {
  const metrics: Record<string, Metric> = {}
  for (const result of results) {
    if (result.status !== 'passed')
      throw new Error(`Streaming soak ${result.framework}/${result.mode} did not pass`)
    const prefix = `streaming ${result.framework.toLowerCase()}/${result.mode}`
    const { frames, processes } = result.measurements
    // A passed soak must carry every measurement: a null distribution (for
    // example fewer than two frame records) fails closed instead of silently
    // dropping a sample the baseline may not gate yet.
    const need = (name: string, unit: string, value: number | null | undefined, scale = 1) => {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`Passed streaming soak ${prefix} lacks ${name}`)
      add(metrics, `${prefix} ${name}`, unit, value * scale)
    }
    need('updateToAckP50Ms', 'ms', result.application?.stream?.updateToAck?.p50Ms)
    need('updateToAckP95Ms', 'ms', result.application?.stream?.updateToAck?.p95Ms)
    need('frameIntervalP95Ms', 'ms', frames?.intervalMs?.p95)
    need('renderToPaintP95Ms', 'ms', frames?.renderToPaintMs?.p95)
    for (const role of ['host', 'application'] as const)
      need(`${role}PeakRssMB`, 'MB', processes?.[role]?.rssBytes?.max, 1e-6)
  }
  return metrics
}

export function exportMetrics(directory: string, streaming: readonly string[] = []): MetricsFile {
  const comparison = JSON.parse(
    readFileSync(join(directory, 'comparison.json'), 'utf8')
  ) as Comparison
  if (comparison.status !== 'passed')
    throw new Error(`The comparison status is ${comparison.status}; a failed run is not a baseline`)
  // Each recorded process must contribute at most one independent sample.
  // A repeated identity would otherwise reuse one retained report or overwrite
  // an earlier JSONL report before the regression gate sees it.
  const identities = new Set<string>()
  for (const launch of [...comparison.launches, ...(comparison.inputLaunches ?? [])]) {
    if (typeof launch.name !== 'string' || !launch.name)
      throw new Error('Comparison launch lacks a name')
    if (identities.has(launch.name)) throw new Error(`Duplicate comparison launch ${launch.name}`)
    identities.add(launch.name)
  }
  const expectedReportNames = new Set(comparison.launches.map((launch) => launch.name))
  const reports = new Map<string, Record<string, unknown> | null>()
  for (const row of readJsonl(join(directory, 'launches.jsonl.gz'))) {
    const name = row['name']
    if (typeof name !== 'string' || !name) throw new Error('Retained launch report lacks a name')
    // The exporter emits reports only for comparison launches, never input trials.
    // Unreferenced records cannot silently survive into an accepted baseline.
    if (!expectedReportNames.has(name))
      throw new Error(`Unexpected retained launch report ${name}`)
    if (reports.has(name)) throw new Error(`Duplicate retained launch report ${name}`)
    reports.set(name, row['report'] as Record<string, unknown> | null)
  }
  const metrics = fromComparison(comparison, reports)
  // Paths and hard links to the same physical soak must not become independent launches.
  const seenStreaming = new Set<string>()
  const seenStreamingFiles = new Set<string>()
  const streamed = fromStreaming(
    streaming.map((path) => {
      const identity = realpathSync(path)
      const stats = statSync(identity, { bigint: true })
      // Some filesystems do not expose inode identity; retain the path guard there.
      const fileId = stats.ino === 0n ? null : `${stats.dev}:${stats.ino}`
      if (seenStreaming.has(identity) || (fileId !== null && seenStreamingFiles.has(fileId)))
        throw new Error(`Duplicate streaming result ${identity}`)
      seenStreaming.add(identity)
      if (fileId !== null) seenStreamingFiles.add(fileId)
      return JSON.parse(readFileSync(path, 'utf8')) as StreamingResult
    })
  )
  for (const [name, metric] of Object.entries(streamed)) {
    if (Object.hasOwn(metrics, name)) throw new Error(`Duplicate metric ${name}`)
    metrics[name] = metric
  }
  if (!Object.keys(metrics).length) throw new Error('The run produced no metric samples')
  return { schemaVersion: 1, environment: { label: environmentLabel(comparison) }, metrics }
}

/** The committed baseline with exactly this label, or null. Two matches fail. */
export function findBaseline(
  directory: string,
  label: string
): { path: string; file: MetricsFile } | null {
  const matches = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const path = join(directory, name)
      return { path, file: parseMetrics(readFileSync(path, 'utf8'), path) }
    })
    .filter(({ file }) => file.environment.label === label)
  if (matches.length > 1)
    throw new Error(`Several baselines share "${label}": ${matches.map((m) => m.path).join(', ')}`)
  return matches[0] ?? null
}

export function gate(
  current: MetricsFile,
  baselines: string,
  threshold = 0.1
): { markdown: string; failed: boolean } {
  const label = current.environment.label
  const found = findBaseline(baselines, label)
  if (!found)
    return {
      failed: false,
      markdown: [
        `No committed baseline matches \`${label}\`, so this run is recorded but not gated.`,
        'Samples from different hardware or operating systems are never compared.',
        `To adopt this run as the baseline for that environment, commit its \`metrics.json\` artifact under \`${baselines}/\` with the run link in \`${baselines}/README.md\`.`,
      ].join('\n'),
    }
  const comparison = compare(found.file, current, { threshold })
  const ungated = Object.keys(current.metrics).filter((name) => !(name in found.file.metrics))
  const lines = [`Baseline: \`${basename(found.path)}\``, '', summary(comparison)]
  if (ungated.length)
    lines.push(
      '',
      `Recorded without a baseline value (not gated until the baseline records them): ${ungated.join(', ')}`
    )
  return { markdown: lines.join('\n'), failed: failed(comparison) }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

export function main(args: string[]): number {
  const [command, ...rest] = args
  if (command === 'export') {
    const [directory] = rest
    const output = option(rest, '--output')
    const streamingIndex = rest.indexOf('--streaming')
    const streaming =
      streamingIndex === -1
        ? []
        : rest.slice(streamingIndex + 1).filter((value) => !value.startsWith('--'))
    if (!directory || !output)
      throw new Error('usage: metrics.ts export EXPORT_DIR --output FILE [--streaming RESULT...]')
    if (existsSync(output)) throw new Error(`${output} already exists`)
    const file = exportMetrics(resolve(directory), streaming)
    writeFileSync(output, JSON.stringify(file, null, 2) + '\n')
    console.log(
      `${Object.keys(file.metrics).length} metrics for "${file.environment.label}" written to ${output}`
    )
    return 0
  }
  if (command === 'gate') {
    const [currentPath, baselines] = rest
    const thresholdText = option(rest, '--threshold')
    const threshold = thresholdText === undefined ? 0.1 : Number(thresholdText)
    if (!currentPath || !baselines || !(threshold > 0) || !Number.isFinite(threshold))
      throw new Error('usage: metrics.ts gate CURRENT.json BASELINE_DIR [--threshold 0.10]')
    const current = parseMetrics(readFileSync(currentPath, 'utf8'), currentPath)
    const result = gate(current, baselines, threshold)
    console.log(result.markdown)
    return result.failed ? 1 : 0
  }
  throw new Error('usage: metrics.ts export|gate ...')
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
