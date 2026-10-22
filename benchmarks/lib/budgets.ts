import { compareRuns, validateRun, type BenchmarkRun, type Unit } from './results.ts'
export const STAGES = [
  'cold-install',
  'warm-dev-launch',
  'frontend-edit-to-usable',
  'backend-edit-to-usable',
  'app-assembly',
  'release-signing',
  'release-compression',
  'first-usable-interaction',
  'idle-observation',
  'input-latency',
  'stream-latency',
  'distribution',
] as const
export type Stage = (typeof STAGES)[number]
export interface StageMeasure {
  readonly stage: Stage
  readonly outcome: 'measured' | 'unsupported' | 'failed'
  readonly durationMs?: number
  readonly reason?: string
  readonly bytes?: Readonly<
    Partial<
      Record<'installed' | 'compressedInstaller' | 'firstRunDownload' | 'cache' | 'update', number>
    >
  >
}
export interface StageLedger {
  readonly sourceCommit: string
  readonly entries: readonly StageMeasure[]
}
export function validateStageLedger(input: StageLedger): StageLedger {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.sourceCommit !== 'string' ||
    !Array.isArray(input.entries) ||
    Object.keys(input).some((key) => !['sourceCommit', 'entries'].includes(key))
  )
    throw new Error('Invalid stage ledger')
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit)) throw new Error('Unpinned stage source')
  const seen = new Set<string>()
  for (const entry of input.entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).some(
        (key) => !['stage', 'outcome', 'durationMs', 'reason', 'bytes'].includes(key)
      )
    )
      throw new Error('Invalid stage entry')
    if (!['measured', 'unsupported', 'failed'].includes(entry.outcome))
      throw new Error('Unknown stage outcome')
    if (entry.reason !== undefined && typeof entry.reason !== 'string')
      throw new Error('Invalid stage reason')
    if (
      entry.bytes !== undefined &&
      (!entry.bytes || typeof entry.bytes !== 'object' || Array.isArray(entry.bytes))
    )
      throw new Error('Invalid byte object')
    if (!STAGES.includes(entry.stage)) throw new Error('Unknown measurement stage')
    if (seen.has(entry.stage)) throw new Error('Duplicate measurement stage')
    seen.add(entry.stage)
    if (entry.outcome === 'measured') {
      if (
        typeof entry.durationMs !== 'number' ||
        !Number.isFinite(entry.durationMs) ||
        entry.durationMs < 0
      )
        throw new Error('Missing valid measured duration')
      if (entry.reason !== undefined) throw new Error('Measured stage cannot carry failure reason')
    } else if (
      !entry.reason?.trim() ||
      entry.durationMs !== undefined ||
      entry.bytes !== undefined
    ) {
      throw new Error('Failed/unsupported stages cannot manufacture measurements')
    }
    for (const [name, value] of Object.entries(entry.bytes ?? {})) {
      if (
        !['installed', 'compressedInstaller', 'firstRunDownload', 'cache', 'update'].includes(
          name
        ) ||
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0
      )
        throw new Error('Invalid byte accounting')
    }
    if (entry.bytes && entry.stage !== 'distribution')
      throw new Error('Distribution bytes require their own stage')
  }
  return input
}
export interface RegressionBudget {
  readonly scenario: string
  readonly metric: string
  readonly unit: Unit
  /** Allowed increase from baseline. A target, not a measured performance claim. */
  readonly maxIncreasePercent: number
}
export function evaluateBudgets(
  before: BenchmarkRun,
  after: BenchmarkRun,
  beforeId: string,
  afterId: string,
  budgets: readonly RegressionBudget[]
) {
  validateRun(before)
  validateRun(after)
  const comparison = compareRuns(before, after, beforeId, afterId)
  if (!comparison.comparable)
    return { comparable: false as const, reasons: comparison.reasons, checks: [] }
  const seen = new Set<string>()
  const checks = budgets.map((budget) => {
    if (
      !budget.scenario ||
      !budget.metric ||
      !Number.isFinite(budget.maxIncreasePercent) ||
      budget.maxIncreasePercent < -100
    )
      throw new Error('Invalid regression budget')
    const key = budget.scenario + ':' + budget.metric
    if (seen.has(key)) throw new Error('Duplicate regression budget')
    seen.add(key)
    const change = comparison.changes.find(
      (row) => row.scenario === budget.scenario && row.metric === budget.metric
    )
    if (!change || change.unit !== budget.unit || change.changePercent === null)
      throw new Error('Unmeasurable regression budget')
    return {
      ...budget,
      actualChangePercent: change.changePercent,
      passed: change.changePercent <= budget.maxIncreasePercent,
    }
  })
  if (!checks.length) throw new Error('Empty regression budget')
  return { comparable: true as const, reasons: [], checks }
}
