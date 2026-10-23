/** Descriptive uncertainty for explicit profiling, never a wall-clock test gate. */
import { quantile, summarize } from '../lib/statistics.ts'

/** Reuse the maintained benchmark statistics and retain the original trial order. */
export function distribution(samples: readonly number[]) {
  if (samples.length > 10000) throw new Error('Too many profile observations')
  return {
    ...summarize(samples, 0x4e494654),
    p90: quantile(samples, 0.9),
    samples: [...samples],
  }
}

export interface ProfileOptions {
  readonly output: string
  readonly samples: number
  readonly warmups: number
}

export function profileOptions(args: readonly string[], defaultOutput: string): ProfileOptions {
  let output = defaultOutput
  let samples = 9
  let warmups = 1
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!
    const value = args[index + 1]
    if (
      seen.has(name) ||
      value === undefined ||
      !['--output', '--samples', '--warmups'].includes(name)
    )
      throw new Error('Use --output PATH --samples 5..100 --warmups 0..10, each at most once')
    seen.add(name)
    if (name === '--output') {
      if (!value || value.includes('\0')) throw new Error('Invalid profile output')
      output = value
    } else {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid profile repetition count')
      const count = Number(value)
      if (name === '--samples') samples = count
      else warmups = count
    }
  }
  if (samples < 5 || samples > 100 || warmups < 0 || warmups > 10)
    throw new Error('Profile repetitions must be samples 5..100 and warmups 0..10')
  return { output, samples, warmups }
}
