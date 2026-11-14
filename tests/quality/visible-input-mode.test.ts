import { expect, test } from 'bun:test'
import { inputScenario } from '../../benchmarks/solid/input-scenario.ts'

test('visible input, traced input and calibration are mutually exclusive', () => {
  expect(inputScenario(false, false, false)).toBeNull()
  expect(inputScenario(true, false, false)).toBe('input-latency')
  expect(inputScenario(false, true, false)).toBe('visible-input')
  expect(() => inputScenario(true, true, false)).toThrow()
  expect(() => inputScenario(true, false, true)).toThrow()
  expect(() => inputScenario(false, true, true)).toThrow()
})
