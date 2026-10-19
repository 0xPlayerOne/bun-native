import { expect, test } from 'bun:test'
import { developmentScenario } from '../benchmarks/adapters/development/driver.ts'

test('real private backend failure is observed before restart and retains only fixture disk state', async () => {
  const result = await developmentScenario('backend-crash')
  expect(result.status).toBe('passed')
  expect(result.correctness.passed).toBe(true)
  expect(result.metrics['persistedCounter']?.value).toBe(1)
  expect(result.metrics['backendFailureToObserved']?.value).toBeGreaterThan(0)
  expect(result.metrics['backendRestartToUsable']?.value).toBeGreaterThan(0)
}, 15000)
