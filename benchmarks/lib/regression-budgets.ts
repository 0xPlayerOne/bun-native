import { compareRuns, validateRun, type Unit } from './results.ts'
import { quantile } from './statistics.ts'
export interface RegressionBudget {
  readonly scenario: string
  readonly metric: string
  readonly unit: Unit
  readonly statistic: 'mean' | 'p50' | 'p95' | 'p99'
  readonly direction: 'lower' | 'higher'
  readonly maxRegressionPercent: number
  /** Maximum regression in the metric's native unit; required for zero baselines. */
  readonly maxAbsoluteRegression?: number
  readonly minimumSamples: number
}
export function regressionBudget(input: unknown): RegressionBudget {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid budget')
  const value = input as Record<string, unknown>
  const required = [
    'scenario',
    'metric',
    'unit',
    'statistic',
    'direction',
    'maxRegressionPercent',
    'minimumSamples',
  ]
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => ![...required, 'maxAbsoluteRegression'].includes(key))
  )
    throw new Error('Unexpected budget fields')
  for (const key of ['scenario', 'metric'])
    if (
      typeof value[key] !== 'string' ||
      !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(value[key] as string)
    )
      throw new Error('Invalid budget selector')
  if (
    !['ms', 'bytes', 'count', 'percent'].includes(String(value['unit'])) ||
    !['mean', 'p50', 'p95', 'p99'].includes(String(value['statistic'])) ||
    !['lower', 'higher'].includes(String(value['direction']))
  )
    throw new Error('Unknown budget metric profile')
  for (const key of [
    'maxRegressionPercent',
    ...(Object.hasOwn(value, 'maxAbsoluteRegression') ? ['maxAbsoluteRegression'] : []),
  ]) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Number(value[key]) < 0)
      throw new Error('Invalid budget threshold')
  }
  if (
    !Number.isSafeInteger(value['minimumSamples']) ||
    Number(value['minimumSamples']) < 2 ||
    Number(value['minimumSamples']) > 100000
  )
    throw new Error('Invalid minimum sample count')
  return Object.freeze({ ...value }) as unknown as RegressionBudget
}
export function evaluateBudgets(
  beforeInput: unknown,
  afterInput: unknown,
  beforeId: string,
  afterId: string,
  inputs: readonly unknown[]
) {
  if (!inputs.length || inputs.length > 256) throw new Error('Expected bounded nonempty budgets')
  const budgets = inputs.map(regressionBudget)
  const selectors = budgets.map((b) => `${b.scenario}\0${b.metric}\0${b.statistic}`)
  if (new Set(selectors).size !== selectors.length) throw new Error('Duplicate regression budget')
  const comparison = compareRuns(beforeInput, afterInput, beforeId, afterId)
  if (!comparison.comparable)
    return { status: 'ineligible' as const, reasons: comparison.reasons, checks: [] }
  const before = validateRun(beforeInput),
    after = validateRun(afterInput)
  const checks = budgets.map((budget) => {
    const extract = (run: typeof before, id: string) =>
      run.trials
        .filter((row) => row.variant === id && row.scenario === budget.scenario && !row.warmup)
        .map((row) => {
          const value = row.metrics[budget.metric]
          if (row.status !== 'passed' || !value || value.unit !== budget.unit)
            throw new Error('Budget has no matching successful metric')
          return value.value
        })
    if (!before.scenarios.includes(budget.scenario)) throw new Error('Unknown budget scenario')
    const left = extract(before, beforeId),
      right = extract(after, afterId)
    if (Math.min(left.length, right.length) < budget.minimumSamples)
      return {
        budget,
        status: 'ineligible' as const,
        reason: 'Insufficient independent trials',
        before: null,
        after: null,
        regressionPercent: null,
        regressionAbsolute: null,
      }
    const statistic = (values: number[]) =>
      budget.statistic === 'mean'
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : quantile(
            values,
            budget.statistic === 'p50' ? 0.5 : budget.statistic === 'p95' ? 0.95 : 0.99
          )
    const a = statistic(left),
      b = statistic(right),
      difference = (b - a) * (budget.direction === 'lower' ? 1 : -1)
    const percent = a === 0 ? null : (difference / a) * 100
    if (a === 0 && budget.maxAbsoluteRegression === undefined)
      return {
        budget,
        status: 'ineligible' as const,
        reason: 'Zero baseline requires an absolute budget',
        before: a,
        after: b,
        regressionPercent: percent,
        regressionAbsolute: difference,
      }
    const failed =
      (percent !== null && percent > budget.maxRegressionPercent) ||
      (budget.maxAbsoluteRegression !== undefined && difference > budget.maxAbsoluteRegression)
    return {
      budget,
      status: failed ? ('failed' as const) : ('passed' as const),
      reason: failed ? 'Regression exceeds configured goal' : 'Within configured goal',
      before: a,
      after: b,
      regressionPercent: percent,
      regressionAbsolute: difference,
    }
  })
  return {
    status: checks.some((c) => c.status === 'ineligible')
      ? ('ineligible' as const)
      : checks.some((c) => c.status === 'failed')
        ? ('failed' as const)
        : ('passed' as const),
    reasons: [],
    checks,
  }
}
