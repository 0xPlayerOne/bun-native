import { expect, test } from 'bun:test'
import { visiblePairsPlan } from '../../benchmarks/electrobun/visible-pairs-plan.ts'

test('visible pair plan has balanced controls and alternating fresh-process comparisons', () => {
  const plan = visiblePairsPlan(4)
  expect(plan.slice(0, 2).map((trial) => trial.variant)).toEqual(['reference', 'native'])
  for (const variant of ['reference', 'native'])
    for (let pair = 0; pair < 3; pair++)
      expect(
        plan.filter(
          (trial) => trial.phase === 'control' && trial.pair === pair && trial.variant === variant
        )
      ).toHaveLength(2)
  expect(
    plan.filter((trial) => trial.phase === 'comparison').map((trial) => trial.variant)
  ).toEqual([
    'reference',
    'native',
    'native',
    'reference',
    'reference',
    'native',
    'native',
    'reference',
  ])
  for (const count of [0, 2, 21, 3.5, NaN]) expect(() => visiblePairsPlan(count)).toThrow()
})
