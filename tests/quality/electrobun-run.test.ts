import { describe, expect, test } from 'bun:test'
import { failedLaunches, runStatus } from '../../benchmarks/electrobun/status.ts'

const launch = (name: string, status: 'passed' | 'failed') => ({ name, status })

describe('Electrobun run validity (#677)', () => {
  test('passes only when the first launch and every measured trial passed', () => {
    expect(
      runStatus(3, [
        launch('first', 'passed'),
        launch('trial-1', 'passed'),
        launch('trial-2', 'passed'),
        launch('trial-3', 'passed'),
      ])
    ).toBe('passed')
  })

  test('a failed first launch fails the run even when every trial passed', () => {
    // The medians exclude the first launch, so its failure used to disappear: a
    // 13.7 s first-launch failure was reported as a 1.98 s median (#677).
    expect(
      runStatus(2, [
        launch('first', 'failed'),
        launch('trial-1', 'passed'),
        launch('trial-2', 'passed'),
      ])
    ).toBe('failed')
  })

  test('a failed measured trial fails the run', () => {
    expect(
      runStatus(2, [
        launch('first', 'passed'),
        launch('trial-1', 'failed'),
        launch('trial-2', 'passed'),
      ])
    ).toBe('failed')
  })

  test('a missing trial fails the run rather than shrinking the sample', () => {
    expect(runStatus(3, [launch('first', 'passed'), launch('trial-1', 'passed')])).toBe('failed')
  })

  test('names every failed launch so none is silently dropped', () => {
    expect(
      failedLaunches([
        launch('first', 'failed'),
        launch('trial-1', 'passed'),
        launch('trial-2', 'failed'),
      ])
    ).toEqual(['first', 'trial-2'])
  })
})
