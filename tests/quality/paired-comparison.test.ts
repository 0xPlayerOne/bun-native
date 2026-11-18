import { describe, expect, test } from 'bun:test'
import {
  ABBA,
  abbaCompare,
  blockDirectory,
  bunNativeSamples,
  electrobunSamples,
  renderMarkdown,
  type Samples,
} from '../../benchmarks/comparison/paired.ts'

const samples = (wallMs: number[], rssMB: number[]): Samples => ({ wallMs, rssMB })

describe('ABBA pairing (#677)', () => {
  test('brackets the second system with the first', () => {
    expect(ABBA).toEqual(['bun-native', 'electrobun', 'electrobun', 'bun-native'])
  })

  test('one block per system is refused', () => {
    expect(() =>
      abbaCompare(
        [samples([1], [1])],
        [samples([1], [1]), samples([1], [1])],
        'wallMs',
        'processWallMs',
        ''
      )
    ).toThrow('two bun-native blocks')
  })

  test('a linear session drift cancels instead of favouring the later system', () => {
    // Each block drifts +10 ms. A single-block comparison would charge that to
    // whichever ran second; ABBA averages it out.
    const bunNative = [samples([100], [10]), samples([130], [10])]
    const electrobun = [samples([110], [20]), samples([140], [20])]
    // The ABBA maths is metric-agnostic; only RSS is exposed as a comparison.
    const wall = abbaCompare(bunNative, electrobun, 'wallMs', 'peakProcessTreeRssMB', 'wall')
    expect(wall.bunNative).toBe(115)
    expect(wall.electrobun).toBe(125)
    expect(wall.ratio).toBeCloseTo(0.92, 5)
    const rss = abbaCompare(bunNative, electrobun, 'rssMB', 'peakProcessTreeRssMB', 'rss')
    expect(rss.ratio).toBeCloseTo(0.5, 5)
  })

  test('reads Bun Native measured launches and skips warm-ups', () => {
    const record = {
      launches: [
        { status: 'passed', warmup: true, process: { wallMs: 9, peakTreeRssBytes: 9e6 } },
        { status: 'passed', process: { wallMs: 100, peakTreeRssBytes: 150e6 } },
        { status: 'failed', process: { wallMs: 1, peakTreeRssBytes: 1e6 } },
        { status: 'passed', process: { wallMs: 120, peakTreeRssBytes: 170e6 } },
      ],
    }
    expect(bunNativeSamples(record)).toEqual({ wallMs: [100, 120], rssMB: [150, 170] })
  })

  test('reads Electrobun measured launches and skips order 0', () => {
    const record = {
      launches: [
        { status: 'passed', order: 0, wallMs: 9, peakTotalRssBytes: 9e6 },
        { status: 'passed', order: 1, wallMs: 30_000, peakTotalRssBytes: 230e6 },
        { status: 'passed', order: 2, wallMs: 32_000, peakTotalRssBytes: 240e6 },
      ],
    }
    expect(electrobunSamples(record)).toEqual({ wallMs: [30_000, 32_000], rssMB: [230, 240] })
  })

  test('refuses a record with no measured launch', () => {
    expect(() => bunNativeSamples({ launches: [] })).toThrow('no launches array')
    expect(() => bunNativeSamples({ launches: [{ status: 'failed', process: {} }] })).toThrow(
      'no measured passed launches'
    )
  })

  test('names each block directory and states what is not compared', () => {
    expect(blockDirectory('/tmp/run', 2)).toBe('/tmp/run-block-2')
    const markdown = renderMarkdown(ABBA, [
      abbaCompare(
        [samples([100], [100]), samples([100], [100])],
        [samples([200], [200]), samples([200], [200])],
        'rssMB',
        'peakProcessTreeRssMB',
        'peak process-tree RSS'
      ),
    ])
    expect(markdown).toContain('| peakProcessTreeRssMB | 100.00 | 200.00 | 0.500 |')
    expect(markdown).toContain('Not compared: wall time, startup and input timing')
  })
})
