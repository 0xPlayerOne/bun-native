#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { bootstrapMedianRatio, median } from '../../benchmarks/comparison/stats.ts'

/**
 * Metric regression gate. It compares a current metrics file with a baseline
 * of the same shape, using the median of independent samples and a bootstrap
 * interval for the ratio, so one noisy runner does not fail a build and a
 * real, stable slowdown is never silently skipped.
 *
 *   bun scripts/quality/regression-check.ts baseline.json current.json [--threshold 0.10]
 *
 * File shape:
 *   { "schemaVersion": 1, "environment": { "label": "linux-x64 ubuntu-24.04 4 cpu" },
 *     "metrics": { "name": { "unit": "ms", "direction": "lower", "samples": [..],
 *                            "reproduce": "command that regenerates the samples" } },
 *     "accepted": { "name": { "maxRatio": 1.25, "adr": "docs/decisions/0000-x.md" } } }
 *
 * Only the baseline's `accepted` entries are read: an accepted tradeoff names
 * an ADR and an upper bound, so it must be reviewed in the baseline itself.
 */

export type Metric = {
  unit: string
  direction: 'lower' | 'higher'
  samples: number[]
  reproduce?: string
}
export type MetricsFile = {
  schemaVersion: 1
  environment: { label: string }
  metrics: Record<string, Metric>
  accepted?: Record<string, { maxRatio: number; adr: string }>
}

export type Status =
  | 'unchanged'
  | 'improved'
  | 'regressed'
  | 'suspected'
  | 'accepted'
  | 'missing'
  | 'unmeasured'

export type Finding = {
  name: string
  status: Status
  unit: string
  baselineMedian: number | null
  currentMedian: number | null
  /** current / baseline, oriented so that above 1 is always worse. */
  ratio: number | null
  low: number | null
  high: number | null
  reproduce: string | undefined
  adr: string | undefined
  note: string
}

export type Comparison = {
  comparable: boolean
  environments: { baseline: string; current: string }
  threshold: number
  findings: Finding[]
}

export function parseMetrics(text: string, what: string): MetricsFile {
  const value = JSON.parse(text) as MetricsFile
  if (value.schemaVersion !== 1) throw new Error(`${what}: schemaVersion must be 1`)
  if (typeof value.environment?.label !== 'string' || value.environment.label === '')
    throw new Error(`${what}: environment.label must name the hardware and operating system`)
  const metrics = Object.entries(value.metrics ?? {})
  if (metrics.length === 0) throw new Error(`${what}: metrics must hold at least one metric`)
  for (const [name, metric] of metrics) {
    if (typeof metric !== 'object' || metric === null)
      throw new Error(`${what}: ${name} must be a metric object`)
    if (typeof metric.unit !== 'string' || metric.unit === '')
      throw new Error(`${what}: ${name} needs a unit`)
    if (!Array.isArray(metric.samples) || metric.samples.some((x) => !Number.isFinite(x)))
      throw new Error(`${what}: ${name} needs finite numeric samples`)
    if (metric.direction !== 'lower' && metric.direction !== 'higher')
      throw new Error(`${what}: ${name} direction must be "lower" or "higher"`)
  }
  // An acceptance exception is a reviewed baseline decision, not an arbitrary
  // JSON value. A numeric string, blank ADR or unrelated metric must not turn
  // an otherwise confirmed regression into a pass via JS coercion.
  if (value.accepted !== undefined) {
    if (
      typeof value.accepted !== 'object' ||
      value.accepted === null ||
      Array.isArray(value.accepted)
    )
      throw new Error(`${what}: accepted must be a map of recorded tradeoffs`)
    for (const [name, tradeoff] of Object.entries(value.accepted)) {
      if (!Object.hasOwn(value.metrics, name))
        throw new Error(`${what}: accepted ${name} does not name a measured metric`)
      if (typeof tradeoff !== 'object' || tradeoff === null || Array.isArray(tradeoff))
        throw new Error(`${what}: accepted ${name} must provide maxRatio and adr`)
      if (
        typeof tradeoff.maxRatio !== 'number' ||
        !Number.isFinite(tradeoff.maxRatio) ||
        tradeoff.maxRatio <= 1
      )
        throw new Error(`${what}: accepted ${name}.maxRatio must be a finite number greater than 1`)
      if (
        typeof tradeoff.adr !== 'string' ||
        !/^docs\/decisions\/\d{4}-[a-z0-9-]+\.md$/.test(tradeoff.adr)
      )
        throw new Error(`${what}: accepted ${name}.adr must reference docs/decisions/NNNN-name.md`)
      // A syntactically plausible but nonexistent ADR must not suppress a stable
      // regression. Resolve against this source checkout, not process.cwd().
      const adrPath = resolve(import.meta.dir, '../..', tradeoff.adr)
      if (!existsSync(adrPath) || !statSync(adrPath).isFile())
        throw new Error(`${what}: accepted ${name}.adr must reference an existing decision file`)
    }
  }
  return value
}

export function compare(
  baseline: MetricsFile,
  current: MetricsFile,
  { threshold = 0.1 }: { threshold?: number } = {}
): Comparison {
  if (!Number.isFinite(threshold) || threshold <= 0)
    throw new RangeError('threshold must be a finite positive number')
  const comparable = baseline.environment.label === current.environment.label
  const findings: Finding[] = []
  for (const [name, reference] of Object.entries(baseline.metrics)) {
    const now = current.metrics[name]
    const empty = {
      name,
      unit: reference.unit,
      reproduce: reference.reproduce,
      adr: undefined,
      low: null,
      high: null,
    }
    if (!now) {
      findings.push({
        ...empty,
        status: 'missing',
        baselineMedian: median(reference.samples),
        currentMedian: null,
        ratio: null,
        note: 'the current run did not report this metric',
      })
      continue
    }
    if (now.unit !== reference.unit || now.direction !== reference.direction) {
      findings.push({
        ...empty,
        status: 'unmeasured',
        baselineMedian: median(reference.samples),
        currentMedian: median(now.samples),
        ratio: null,
        note: `the unit or direction changed (baseline ${reference.unit}, ${reference.direction}; current ${now.unit}, ${now.direction}), so the samples are not comparable`,
      })
      continue
    }
    if (now.samples.length === 0 || reference.samples.length === 0) {
      findings.push({
        ...empty,
        status: 'unmeasured',
        baselineMedian: median(reference.samples),
        currentMedian: median(now.samples),
        ratio: null,
        note: 'a run without samples cannot be compared',
      })
      continue
    }
    // Orient every ratio so that above 1 is worse, whatever the metric means.
    const worse = reference.direction === 'lower'
    const interval = worse
      ? bootstrapMedianRatio(now.samples, reference.samples)
      : bootstrapMedianRatio(reference.samples, now.samples)
    const ratio = interval.estimate
    const accepted = baseline.accepted?.[name]
    let status: Status = 'unchanged'
    let note = 'within the threshold'
    if (ratio === null) {
      status = 'unmeasured'
      note = 'the reference median is not positive'
    } else if (ratio >= 1 + threshold) {
      if (accepted && ratio <= accepted.maxRatio) {
        status = 'accepted'
        note = `a recorded tradeoff up to ${accepted.maxRatio}x (${accepted.adr})`
      } else if (interval.low === null) {
        status = 'suspected'
        note = 'fewer than three samples in a group: no interval, so not proven stable'
      } else if (interval.low > 1) {
        status = 'regressed'
        note = `stable: the ${interval.confidence * 100}% interval excludes no change`
      } else {
        status = 'suspected'
        note = 'the interval includes no change: runner noise is not excluded'
      }
    } else if (ratio <= 1 / (1 + threshold)) {
      status = 'improved'
      note = 'faster or smaller than the baseline'
    }
    findings.push({
      ...empty,
      status,
      adr: accepted?.adr,
      baselineMedian: median(reference.samples),
      currentMedian: median(now.samples),
      ratio,
      low: interval.low,
      high: interval.high,
      note,
    })
  }
  return {
    comparable,
    environments: { baseline: baseline.environment.label, current: current.environment.label },
    threshold,
    findings,
  }
}

/**
 * True when the gate fails: an incomparable environment, no metric compared at
 * all, or any hard finding.
 */
export function failed(comparison: Comparison): boolean {
  return (
    !comparison.comparable ||
    comparison.findings.length === 0 ||
    comparison.findings.some((f) => ['regressed', 'missing', 'unmeasured'].includes(f.status))
  )
}

const number = (value: number | null) => (value === null ? 'n/a' : value.toPrecision(4))

export function summary(comparison: Comparison): string {
  const lines = [
    '| Metric | Status | Baseline | Current | Worse-than ratio (95% interval) | Why |',
    '| --- | --- | ---: | ---: | --- | --- |',
  ]
  for (const f of comparison.findings)
    lines.push(
      `| ${f.name} | ${f.status} | ${number(f.baselineMedian)} ${f.unit} | ${number(f.currentMedian)} ${f.unit} | ${number(f.ratio)} (${number(f.low)} to ${number(f.high)}) | ${f.note} |`
    )
  const out = [
    comparison.comparable
      ? `Environment: ${comparison.environments.current}`
      : `NOT COMPARABLE: baseline "${comparison.environments.baseline}" vs current "${comparison.environments.current}". Samples from different hardware or operating systems are never compared.`,
    `Threshold: ${comparison.threshold * 100}% worse than the baseline median.`,
    '',
    ...lines,
  ]
  for (const f of comparison.findings)
    if (['regressed', 'suspected', 'missing'].includes(f.status) && f.reproduce)
      out.push('', `Reproduce ${f.name}: \`${f.reproduce}\``)
  return out.join('\n')
}

if (import.meta.main) {
  const [baselinePath, currentPath, ...rest] = process.argv.slice(2)
  const thresholdIndex = rest.indexOf('--threshold')
  const threshold = thresholdIndex === -1 ? 0.1 : Number(rest[thresholdIndex + 1])
  if (!baselinePath || !currentPath || !(threshold > 0) || !Number.isFinite(threshold))
    throw new Error('usage: regression-check.ts baseline.json current.json [--threshold 0.10]')
  const comparison = compare(
    parseMetrics(readFileSync(resolve(baselinePath), 'utf8'), baselinePath),
    parseMetrics(readFileSync(resolve(currentPath), 'utf8'), currentPath),
    { threshold }
  )
  console.log(summary(comparison))
  if (failed(comparison)) process.exit(1)
}
