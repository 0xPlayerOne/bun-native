import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  environmentLabel,
  exportMetrics,
  findBaseline,
  fromStreaming,
  gate,
  main,
} from '../../benchmarks/comparison/metrics.ts'
import { parseMetrics, type MetricsFile } from '../../scripts/quality/regression-check.ts'

const BASELINES = resolve(import.meta.dir, '../../benchmarks/comparison/baselines')

function report(scale: number) {
  const samples = (value: number) => [value * scale, value * scale, value * scale]
  return {
    startup: {
      timeOriginEpochMs: 1_000 + 2,
      workloadEntryMs: 10,
      applicationReadyMs: 50,
      windowOpenedMs: 90 * scale,
      viewMountedMs: 100 * scale,
    },
    totalWorkloadMs: 500 * scale,
    lifecycles: { samplesMs: samples(0.5) },
    phases: {
      signals: { acknowledgement: { samplesMs: samples(0.1) } },
      coalesced: { acknowledgement: { samplesMs: samples(0.1) } },
      keyedRotations: { acknowledgement: { samplesMs: samples(0.1) } },
    },
  }
}

type Options = { scale?: number; trials?: number; cold?: boolean; status?: string; cpu?: string }

/** A small exported comparison directory with the shape `export.ts` writes. */
function writeExport({
  scale = 1,
  trials = 5,
  cold = false,
  status = 'passed',
  cpu = 'Test CPU',
}: Options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-metrics-'))
  const launches = []
  const rows = []
  const inputs = []
  for (const adapter of ['core', 'solid']) {
    for (let trial = 0; trial <= trials; trial++) {
      const name = `${adapter}-aot-${trial}`
      launches.push({
        name,
        adapter,
        mode: 'aot',
        trial,
        warmup: trial === 0,
        status: 'passed',
        process: {
          spawnEpochMs: 1_000,
          wallMs: (600 + trial) * scale,
          exitCode: 0,
          pageCacheDropped: cold,
          cpuUserMs: 400 * scale,
          cpuSystemMs: 100 * scale,
          peakTreeRssBytes: 180_000_000 * scale,
          peakApplicationRssBytes: 50_000_000 * scale,
          peakHostRssBytes: 130_000_000,
          rssSamples: 20,
        },
      })
      // A warmup launch with absurd values must never become a sample.
      rows.push({ name, report: trial === 0 ? report(100) : report(scale + trial * 0.001) })
      if (trial > 0)
        inputs.push({
          name: `${adapter}-aot-input-${trial}`,
          adapter,
          mode: 'aot',
          status: 'passed',
          commandStartToPaintObservedMs: (8 + trial * 0.1) * scale,
        })
    }
    launches.push({
      name: `${adapter}-aot-failed`,
      adapter,
      mode: 'aot',
      trial: 99,
      warmup: false,
      status: 'failed',
      process: {
        spawnEpochMs: 1_000,
        wallMs: 1,
        exitCode: 1,
        peakTreeRssBytes: null,
        peakApplicationRssBytes: null,
        peakHostRssBytes: null,
        rssSamples: 0,
      },
    })
  }
  const comparison = {
    schemaVersion: 1,
    status,
    target: {
      os: 'linux',
      osRelease: 'Ubuntu 24.04.5 LTS',
      architecture: 'x64',
      cpuModels: [cpu],
      logicalCpus: 4,
    },
    displayRequest: { vulkanDriverFiles: '/usr/share/vulkan/icd.d/lvp_icd.json' },
    launches,
    inputLaunches: inputs,
  }
  writeFileSync(join(directory, 'comparison.json'), JSON.stringify(comparison))
  writeFileSync(
    join(directory, 'launches.jsonl.gz'),
    gzipSync(rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  )
  return { directory, comparison }
}

function streamingResult(framework: string, mode: string, scale = 1, status = 'passed') {
  return {
    status,
    framework,
    mode,
    application: { stream: { updateToAck: { p50Ms: 0.2 * scale, p95Ms: 1.1 * scale } } },
    measurements: {
      frames: { intervalMs: { p95: 17 * scale }, renderToPaintMs: { p95: 3 * scale } },
      processes: {
        host: { rssBytes: { max: 140_000_000 * scale } },
        application: { rssBytes: { max: 90_000_000 * scale } },
      },
    },
  }
}

function baselineDirectory(...files: MetricsFile[]) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-baselines-'))
  files.forEach((file, index) =>
    writeFileSync(join(directory, `baseline-${index}.json`), JSON.stringify(file))
  )
  return directory
}

describe('benchmark metrics export', () => {
  test('turns measured, passed launches into per-launch samples and ignores warmup and failures', () => {
    const { directory } = writeExport()
    const file = exportMetrics(directory)
    expect(file.environment.label).toBe(
      'linux-x64 | Ubuntu 24.04.5 LTS | 4 cpu | Test CPU | llvmpipe | warm-cache'
    )
    const wall = file.metrics['core/aot processWallMs']!
    expect(wall).toMatchObject({ unit: 'ms', direction: 'lower' })
    expect(wall.samples).toEqual([601, 602, 603, 604, 605])
    expect(file.metrics['solid/aot peakTreeRssMB']!.samples).toEqual([180, 180, 180, 180, 180])
    expect(file.metrics['solid/aot peakTreeRssMB']!.unit).toBe('MB')
    expect(file.metrics['core/aot spawnToViewMountedMs']!.samples[0]).toBeCloseTo(102.1, 5)
    expect(file.metrics['core/aot clickToPaintMs']!.samples).toHaveLength(5)
    expect(file.metrics['core/aot cpuTimeMs']!.samples).toEqual([500, 500, 500, 500, 500])
    expect(Object.keys(file.metrics)).toHaveLength(16)
    for (const metric of Object.values(file.metrics))
      expect(metric.reproduce).toContain('benchmark-comparison.yml')
  })

  test('labels cold-cache runs and GPU renderers separately so they are never compared with warm llvmpipe runs', () => {
    const { comparison } = writeExport({ cold: true })
    expect(environmentLabel(comparison as never)).toEndWith('| llvmpipe | cold-cache')
    expect(
      environmentLabel({ ...comparison, displayRequest: { vulkanDriverFiles: null } } as never)
    ).toContain('| gpu |')
    expect(() =>
      environmentLabel({ ...comparison, target: { ...comparison.target, cpuModels: [] } } as never)
    ).toThrow('lacks the target environment')
  })

  test('refuses a failed comparison and a passed launch without its retained report', () => {
    expect(() => exportMetrics(writeExport({ status: 'failed' }).directory)).toThrow(
      'a failed run is not a baseline'
    )
    const { directory } = writeExport()
    writeFileSync(join(directory, 'launches.jsonl.gz'), gzipSync(''))
    expect(() => exportMetrics(directory)).toThrow('has no retained child report')
  })

  test('adds streaming-list soaks as one sample per launch and refuses a failed soak', () => {
    const metrics = fromStreaming([
      streamingResult('Solid', 'aot'),
      streamingResult('Solid', 'aot', 1.1),
      streamingResult('React', 'development'),
    ])
    expect(metrics['streaming solid/aot frameIntervalP95Ms']!.samples).toEqual([17, 17 * 1.1])
    expect(metrics['streaming react/development applicationPeakRssMB']!.samples).toEqual([90])
    expect(metrics['streaming solid/aot updateToAckP95Ms']!.unit).toBe('ms')
    expect(() => fromStreaming([streamingResult('React', 'aot', 1, 'failed')])).toThrow(
      'did not pass'
    )
    const { directory } = writeExport()
    const path = join(directory, 'stream.json')
    writeFileSync(path, JSON.stringify(streamingResult('Solid', 'aot')))
    expect(Object.keys(exportMetrics(directory, [path]).metrics)).toHaveLength(22)
  })

  test('a passed launch with a missing measurement fails closed instead of losing a sample', () => {
    const edit = (change: (comparison: Record<string, any>) => void) => {
      const { directory, comparison } = writeExport()
      change(comparison)
      writeFileSync(join(directory, 'comparison.json'), JSON.stringify(comparison))
      return () => exportMetrics(directory)
    }
    expect(
      edit((comparison) => {
        comparison['launches'][1].process.cpuSystemMs = null
      })
    ).toThrow('Passed launch core-aot-1 lacks cpuTimeMs')
    expect(
      edit((comparison) => {
        comparison['launches'][2].process.peakTreeRssBytes = null
      })
    ).toThrow('Passed launch core-aot-2 lacks peakTreeRssMB')
    expect(
      edit((comparison) => {
        comparison['inputLaunches'][0].commandStartToPaintObservedMs = null
      })
    ).toThrow('Passed input launch core/aot lacks commandStartToPaintObservedMs')
    // A failed input launch without an observation is not a sample and is ignored.
    const failedInput = edit((comparison) => {
      comparison['inputLaunches'].push({
        name: 'core-aot-input-failed',
        adapter: 'core',
        mode: 'aot',
        status: 'failed',
        commandStartToPaintObservedMs: null,
      })
    })
    expect(failedInput().metrics['core/aot clickToPaintMs']!.samples).toHaveLength(5)
  })

  test('a passed soak with a missing measurement fails closed instead of dropping the sample', () => {
    type Result = Parameters<typeof fromStreaming>[0][number]
    const soak = (result: Record<string, any>) => [result as unknown as Result]
    const noFrames = streamingResult('Solid', 'aot') as Record<string, any>
    noFrames['measurements'].frames.intervalMs.p95 = null
    expect(() => fromStreaming(soak(noFrames))).toThrow(
      'Passed streaming soak streaming solid/aot lacks frameIntervalP95Ms'
    )
    const noHost = streamingResult('React', 'development') as Record<string, any>
    noHost['measurements'].processes.host = null
    expect(() => fromStreaming(soak(noHost))).toThrow('lacks hostPeakRssMB')
    const noAck = streamingResult('React', 'aot') as Record<string, any>
    delete noAck['application'].stream.updateToAck.p95Ms
    expect(() => fromStreaming(soak(noAck))).toThrow('lacks updateToAckP95Ms')
  })
})

describe('benchmark regression gate', () => {
  test('a run on hardware with no committed baseline is reported but not gated', () => {
    const current = exportMetrics(writeExport({ cpu: 'Unseen CPU' }).directory)
    const result = gate(current, baselineDirectory(exportMetrics(writeExport().directory)))
    expect(result.failed).toBe(false)
    expect(result.markdown).toContain('No committed baseline matches')
    expect(result.markdown).toContain('Unseen CPU')
  })

  test('a deliberately slowed run fails against the baseline for its exact environment', () => {
    const baseline = exportMetrics(writeExport().directory)
    const directory = baselineDirectory(baseline)
    const same = gate(exportMetrics(writeExport().directory), directory)
    expect(same.failed).toBe(false)
    const slowed = gate(exportMetrics(writeExport({ scale: 1.3 }).directory), directory)
    expect(slowed.failed).toBe(true)
    expect(slowed.markdown).toContain('| core/aot processWallMs | regressed |')
    expect(slowed.markdown).toContain('Baseline: `baseline-0.json`')
  })

  test('lists metrics without a baseline value instead of silently dropping them, and fails on a missing one', () => {
    const { directory: exportDirectory } = writeExport()
    const path = join(exportDirectory, 'stream.json')
    writeFileSync(path, JSON.stringify(streamingResult('Solid', 'aot')))
    const baselines = baselineDirectory(exportMetrics(writeExport().directory))
    const result = gate(exportMetrics(exportDirectory, [path]), baselines)
    expect(result.failed).toBe(false)
    expect(result.markdown).toContain('Recorded without a baseline value')
    expect(result.markdown).toContain('streaming solid/aot frameIntervalP95Ms')
    const current = exportMetrics(writeExport().directory)
    delete current.metrics['core/aot processWallMs']
    expect(gate(current, baselines).failed).toBe(true)
  })

  test('two baselines with one label are refused', () => {
    const baseline = exportMetrics(writeExport().directory)
    expect(() =>
      findBaseline(baselineDirectory(baseline, baseline), baseline.environment.label)
    ).toThrow('Several baselines share')
  })

  test('committed baselines parse, have unique labels and pass against themselves', () => {
    const names = readdirSync(BASELINES).filter((name) => name.endsWith('.json'))
    expect(names.length).toBeGreaterThanOrEqual(2)
    const labels = new Set<string>()
    for (const name of names) {
      const file = parseMetrics(readFileSync(join(BASELINES, name), 'utf8'), name)
      expect(labels.has(file.environment.label)).toBe(false)
      labels.add(file.environment.label)
      for (const metric of Object.values(file.metrics))
        expect(metric.samples.length).toBeGreaterThanOrEqual(5)
      expect(gate(file, BASELINES).failed).toBe(false)
    }
    expect(readFileSync(join(BASELINES, 'README.md'), 'utf8')).toContain(names[0]!)
  })
})

describe('benchmark metrics command line', () => {
  test('export writes a metrics file once and gate exits 1 only on a regression', () => {
    const work = mkdtempSync(join(tmpdir(), 'bun-native-metrics-cli-'))
    const baselines = join(work, 'baselines')
    mkdirSync(baselines)
    const log = console.log
    console.log = () => {}
    try {
      expect(main(['export', writeExport().directory, '--output', join(baselines, 'a.json')])).toBe(
        0
      )
      expect(() =>
        main(['export', writeExport().directory, '--output', join(baselines, 'a.json')])
      ).toThrow('already exists')
      const ok = join(work, 'ok.json')
      const stream = join(work, 'stream.json')
      writeFileSync(stream, JSON.stringify(streamingResult('React', 'aot')))
      expect(main(['export', writeExport().directory, '--output', ok, '--streaming', stream])).toBe(
        0
      )
      expect(main(['gate', ok, baselines])).toBe(0)
      const slow = join(work, 'slow.json')
      expect(main(['export', writeExport({ scale: 1.3 }).directory, '--output', slow])).toBe(0)
      expect(main(['gate', slow, baselines])).toBe(1)
      expect(main(['gate', slow, baselines, '--threshold', '0.5'])).toBe(0)
    } finally {
      console.log = log
    }
    expect(() => main(['gate', 'x.json'])).toThrow('usage')
    expect(() => main(['gate', 'x.json', 'dir', '--threshold', '0'])).toThrow('usage')
    expect(() => main(['export'])).toThrow('usage')
    expect(() => main([])).toThrow('usage')
  })
})
