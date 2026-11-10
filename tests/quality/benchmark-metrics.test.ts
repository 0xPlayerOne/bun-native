import { describe, expect, test } from 'bun:test'
import { linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
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
      const name = trial === 0 ? `${adapter}-aot-first` : `${adapter}-aot-${trial}`
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
          trial,
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
  // Input-latency exporter preserves each XTest driver's observation.
  const inputRows = inputs.map((item) => ({
    name: item.name,
    report: report(1),
    driver: {
      status: 'passed',
      measurements: {
        native_paint_file_observation: {
          command_start_to_paint_observed_ms: item.commandStartToPaintObservedMs,
        },
      },
    },
  }))
  writeFileSync(
    join(directory, 'input-launches.jsonl.gz'),
    gzipSync(inputRows.map((row) => JSON.stringify(row)).join('\n') + '\n')
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

  test('requires the retained child report of every declared successful first launch', () => {
    const { directory, comparison } = writeExport({ trials: 3 })
    const record = {
      ...comparison,
      launches: comparison.launches.filter((launch) => launch.status === 'passed'),
      methodology: { adapters: ['core', 'solid'], modes: ['aot'], measuredTrials: 3 },
    }
    writeFileSync(join(directory, 'comparison.json'), JSON.stringify(record))
    const path = join(directory, 'launches.jsonl.gz')
    const original = gunzipSync(readFileSync(path)).toString('utf8').trimEnd().split('\n')
    const name = 'core-aot-first'
    const save = (lines: string[]) => writeFileSync(path, gzipSync(lines.join('\n') + '\n'))
    expect(() => exportMetrics(directory)).not.toThrow()

    // The exporter retains one row for every launch. Cohort validation alone
    // previously accepted a completed first launch with no retained evidence.
    save(original.filter((line) => (JSON.parse(line) as { name: string }).name !== name))
    expect(() => exportMetrics(directory)).toThrow(
      'Passed first launch core-aot-first has no retained child report'
    )

    // A present row with an absent child payload is equally insufficient.
    save(
      original.map((line) => {
        const row = JSON.parse(line) as { name: string; report: unknown }
        return JSON.stringify(row.name === name ? { ...row, report: null } : row)
      })
    )
    expect(() => exportMetrics(directory)).toThrow(
      'Passed first launch core-aot-first has no retained child report'
    )

    save(original)
    expect(() => exportMetrics(directory)).not.toThrow()
  })

  test('rejects duplicate launch and retained-report names instead of reusing a sample', () => {
    const { directory, comparison } = writeExport()
    comparison.launches.push({ ...comparison.launches[1]! })
    writeFileSync(join(directory, 'comparison.json'), JSON.stringify(comparison))
    expect(() => exportMetrics(directory)).toThrow('Duplicate comparison launch core-aot-1')

    const input = writeExport()
    input.comparison.inputLaunches.push({ ...input.comparison.inputLaunches[0]! })
    writeFileSync(join(input.directory, 'comparison.json'), JSON.stringify(input.comparison))
    expect(() => exportMetrics(input.directory)).toThrow(
      'Duplicate comparison launch core-aot-input-1'
    )

    const recorded = writeExport()
    const path = join(recorded.directory, 'launches.jsonl.gz')
    const lines = gunzipSync(readFileSync(path)).toString('utf8').trimEnd().split('\n')
    writeFileSync(path, gzipSync([...lines, lines[1]!].join('\n') + '\n'))
    expect(() => exportMetrics(recorded.directory)).toThrow(
      'Duplicate retained launch report core-aot-1'
    )
  })

  test('refuses incomplete or duplicated recorded trial cohorts despite passed status', () => {
    const { directory, comparison } = writeExport({ trials: 3 })
    // The writer's successful controller records only passed processes. Keep
    // the older mixed-status fixture behavior for the other exporter tests.
    const record = {
      ...comparison,
      launches: comparison.launches.filter((launch) => launch.status === 'passed'),
      methodology: { adapters: ['core', 'solid'], modes: ['aot'], measuredTrials: 3 },
    }
    const save = () => writeFileSync(join(directory, 'comparison.json'), JSON.stringify(record))
    save()
    expect(() => exportMetrics(directory)).not.toThrow()

    // Before cohort validation both missing fourth trials and distinct names
    // claiming the same adapter/mode/trial were accepted as a valid baseline.
    record.methodology.measuredTrials = 4
    save()
    expect(() => exportMetrics(directory)).toThrow('Missing comparison trials: core/aot/4')

    record.methodology.measuredTrials = 3
    const duplicated = record.launches.find((launch) => launch.name === 'solid-aot-2')!
    duplicated.trial = 1
    save()
    expect(() => exportMetrics(directory)).toThrow('Duplicate comparison trial solid/aot/1')

    duplicated.trial = 2
    record.methodology.modes.push('development')
    save()
    expect(() => exportMetrics(directory)).toThrow('Missing comparison trials: core/development/1')

    // A forged run cannot request billions of expected samples and exhaust
    // the exporter while building its expected-trial identities.
    record.methodology.measuredTrials = 1_000_000_000
    save()
    expect(() => exportMetrics(directory)).toThrow('lacks a valid trial cohort')
  })

  test('rejects invented benchmark adapters and modes even with complete sample counts', () => {
    const { directory, comparison } = writeExport({ trials: 3 })
    const passed = comparison.launches.filter((launch) => launch.status === 'passed')
    const record = {
      ...comparison,
      launches: passed,
      inputLaunches: [],
      methodology: {
        adapters: ['core', 'solid'],
        modes: ['aot'],
        measuredTrials: 3,
        inputLatency: null,
      },
    }
    const save = () => writeFileSync(join(directory, 'comparison.json'), JSON.stringify(record))

    save()
    expect(() => exportMetrics(directory)).not.toThrow()

    // The old validator accepted a fictitious adapter so long as its sample
    // names and measured-trial indices matched its forged methodology.
    record.methodology.adapters[1] = 'invented'
    record.launches = passed.map((launch) => ({
      ...launch,
      adapter: launch.adapter === 'solid' ? 'invented' : launch.adapter,
    }))
    save()
    expect(() => exportMetrics(directory)).toThrow('lacks a valid trial cohort')

    // A fictitious execution mode was accepted in exactly the same way.
    record.methodology.adapters[1] = 'solid'
    record.methodology.modes[0] = 'invented'
    record.launches = passed.map((launch) => ({ ...launch, mode: 'invented' }))
    save()
    expect(() => exportMetrics(directory)).toThrow('lacks a valid trial cohort')
  })

  test('rejects swapped process names that silently exchange measured trial reports', () => {
    const { directory, comparison } = writeExport({ trials: 3 })
    const record = {
      ...comparison,
      launches: comparison.launches.filter((launch) => launch.status === 'passed'),
      methodology: {
        adapters: ['core', 'solid'],
        modes: ['aot'],
        measuredTrials: 3,
        inputLatency: { trials: 3 },
      },
    }
    const save = () => writeFileSync(join(directory, 'comparison.json'), JSON.stringify(record))
    const swapNames = (left: { name: string }, right: { name: string }) => {
      const name = left.name
      left.name = right.name
      right.name = name
    }
    save()
    expect(() => exportMetrics(directory)).not.toThrow()

    // Every cohort identity and report name still exists. Before name checks,
    // two distinct trials could borrow each other's retained report samples.
    const first = record.launches.find((launch) => launch.name === 'core-aot-1')!
    const second = record.launches.find((launch) => launch.name === 'core-aot-2')!
    swapNames(first, second)
    save()
    expect(() => exportMetrics(directory)).toThrow(
      'Comparison trial core/aot/1 has mismatched launch name core-aot-2'
    )
    swapNames(first, second)

    // Input measurements must also retain their controller-generated process
    // identities despite not consuming the retained comparison JSONL reports.
    const inputFirst = record.inputLaunches.find(
      (launch) => launch.name === 'core-aot-input-1'
    )!
    const inputSecond = record.inputLaunches.find(
      (launch) => launch.name === 'core-aot-input-2'
    )!
    swapNames(inputFirst, inputSecond)
    save()
    expect(() => exportMetrics(directory)).toThrow(
      'Input comparison trial core/aot/1 has mismatched launch name core-aot-input-2'
    )
    swapNames(inputFirst, inputSecond)
    save()
    expect(() => exportMetrics(directory)).not.toThrow()
  })

  test('requires one successful first-launch warmup for every declared adapter/mode', () => {
    const { directory, comparison } = writeExport({ trials: 3 })
    const launches = comparison.launches.filter((launch) => launch.status === 'passed')
    const record = {
      ...comparison,
      launches: launches.map((launch) => ({ ...launch })),
      methodology: { adapters: ['core', 'solid'], modes: ['aot'], measuredTrials: 3 },
    }
    const save = () => writeFileSync(join(directory, 'comparison.json'), JSON.stringify(record))
    save()
    expect(() => exportMetrics(directory)).not.toThrow()

    // A forged first-launch identity previously passed cohort validation when
    // its retained JSONL name was changed consistently. The controller always
    // names trial-zero processes `<adapter>-<mode>-first`.
    const firstLaunch = record.launches.find(
      (launch) => launch.warmup && launch.adapter === 'core'
    )!
    const reportsPath = join(directory, 'launches.jsonl.gz')
    const originalReports = gunzipSync(readFileSync(reportsPath)).toString('utf8')
    expect(originalReports).toContain('"name":"core-aot-first"')
    firstLaunch.name = 'core-aot-first-forged'
    writeFileSync(
      reportsPath,
      gzipSync(
        originalReports.replace('"name":"core-aot-first"', '"name":"core-aot-first-forged"')
      )
    )
    save()
    expect(() => exportMetrics(directory)).toThrow(
      'Comparison first launch core/aot has mismatched launch name core-aot-first-forged'
    )
    record.launches = launches.map((launch) => ({ ...launch }))
    writeFileSync(reportsPath, gzipSync(originalReports))
    save()
    expect(() => exportMetrics(directory)).not.toThrow()

    // Previously all three malformed records were accepted: only measured
    // launches were checked, even though trial zero runs each built artifact.
    record.launches = launches.filter((launch) => !(launch.warmup && launch.adapter === 'core'))
    save()
    expect(() => exportMetrics(directory)).toThrow('Missing comparison first launches: core/aot')

    record.launches = launches.map((launch) => ({ ...launch }))
    const first = record.launches.find((launch) => launch.warmup && launch.adapter === 'core')!
    first.status = 'failed'
    save()
    expect(() => exportMetrics(directory)).toThrow('Non-passing or invalid comparison first launch core/aot')

    first.status = 'passed'
    record.launches.push({ ...first, name: 'core-aot-first-copy' })
    save()
    expect(() => exportMetrics(directory)).toThrow('Duplicate comparison first launch core/aot')
  })

  test('declared input trials retain matching XTest and child evidence', () => {
    const { directory, comparison } = writeExport({ trials: 3 })
    writeFileSync(
      join(directory, 'comparison.json'),
      JSON.stringify({
        ...comparison,
        launches: comparison.launches.filter((launch) => launch.status === 'passed'),
        methodology: {
          adapters: ['core', 'solid'],
          modes: ['aot'],
          measuredTrials: 3,
          inputLatency: { trials: 3 },
        },
      })
    )
    const path = join(directory, 'input-launches.jsonl.gz')
    const original = gunzipSync(readFileSync(path)).toString('utf8').trimEnd().split('\n')
    const save = (lines: string[]) => writeFileSync(path, gzipSync(lines.join('\n') + '\n'))
    const name = 'core-aot-input-1'
    const change = (replacement: Record<string, unknown>) =>
      save(
        original.map((line) => {
          const row = JSON.parse(line) as { name: string; report: unknown; driver: unknown }
          return JSON.stringify(row.name === name ? { ...row, ...replacement } : row)
        })
      )

    expect(() => exportMetrics(directory)).not.toThrow()
    save(original.filter((line) => (JSON.parse(line) as { name: string }).name !== name))
    expect(() => exportMetrics(directory)).toThrow('Missing retained input launches: core-aot-input-1')
    save([...original, original[0]!])
    expect(() => exportMetrics(directory)).toThrow('Duplicate retained input launch core-aot-input-1')
    change({ report: null })
    expect(() => exportMetrics(directory)).toThrow('has no retained child report')
    change({ driver: { status: 'failed' } })
    expect(() => exportMetrics(directory)).toThrow('has no successful retained XTest driver')
    change({
      driver: {
        status: 'passed',
        measurements: {
          native_paint_file_observation: { command_start_to_paint_observed_ms: 0.001 },
        },
      },
    })
    expect(() => exportMetrics(directory)).toThrow('has mismatched retained XTest latency')
    save(original)
    expect(() => exportMetrics(directory)).not.toThrow()
  })

  test('requires all declared input-latency trials for a passed benchmark baseline', () => {
    const { directory, comparison } = writeExport({ trials: 3 })
    const originals = comparison.inputLaunches.map((launch) => ({ ...launch }))
    const record = {
      ...comparison,
      launches: comparison.launches.filter((launch) => launch.status === 'passed'),
      inputLaunches: originals.map((launch) => ({ ...launch })),
      methodology: {
        adapters: ['core', 'solid'],
        modes: ['aot'],
        measuredTrials: 3,
        inputLatency: { trials: 3 },
      },
    }
    const save = () => writeFileSync(join(directory, 'comparison.json'), JSON.stringify(record))
    save()
    expect(() => exportMetrics(directory)).not.toThrow()

    // Before this check, dropping an entire passed input sample was accepted.
    record.inputLaunches.pop()
    save()
    expect(() => exportMetrics(directory)).toThrow('Missing input comparison trials: solid/aot/3')

    record.inputLaunches = originals.map((launch) => ({ ...launch }))
    record.inputLaunches[5]!.trial = 2
    save()
    expect(() => exportMetrics(directory)).toThrow('Duplicate input comparison trial solid/aot/2')

    record.inputLaunches = originals.map((launch) => ({ ...launch }))
    record.inputLaunches[0]!.status = 'failed'
    save()
    expect(() => exportMetrics(directory)).toThrow('Non-passing input comparison trial core/aot/1')

    record.inputLaunches = originals.map((launch) => ({ ...launch }))
    record.methodology.inputLatency.trials = 1_000_000_000
    save()
    expect(() => exportMetrics(directory)).toThrow('lacks a valid input trial cohort')
  })

  test('explicitly disabled input-latency measurement cannot contain input launches', () => {
    const { directory, comparison } = writeExport({ trials: 3 })
    const record = {
      ...comparison,
      methodology: {
        adapters: ['core', 'solid'],
        modes: ['aot'],
        measuredTrials: 3,
        inputLatency: null,
      },
    }
    const save = (value: object) =>
      writeFileSync(join(directory, 'comparison.json'), JSON.stringify(value))

    // The real controller writes inputLatency: null with zero input launches.
    // Previously a forged passed export could retain one undeclared input
    // sample and silently produce an undersampled click-to-paint baseline.
    record.inputLaunches = record.inputLaunches.slice(0, 1)
    save(record)
    expect(() => exportMetrics(directory)).toThrow(
      'Comparison declares no input-latency trials but contains input launches'
    )
    record.inputLaunches = []
    save(record)
    expect(() => exportMetrics(directory)).not.toThrow()

    // Older archives without the field stay readable; only an explicit
    // controller opt-out rules out recorded input launches.
    save({
      ...record,
      inputLaunches: comparison.inputLaunches,
      methodology: { adapters: ['core', 'solid'], modes: ['aot'], measuredTrials: 3 },
    })
    expect(() => exportMetrics(directory)).not.toThrow()
  })

  test('rejects retained reports not linked to comparison launches', () => {
    const { directory, comparison } = writeExport()
    const path = join(directory, 'launches.jsonl.gz')
    const rows = gunzipSync(readFileSync(path)).toString('utf8').trimEnd().split('\n')
    const writeExtra = (name: string) =>
      writeFileSync(
        path,
        gzipSync([...rows, JSON.stringify({ name, report: report(1) })].join('\n') + '\n')
      )

    // A stray report used to be silently ignored when constructing the baseline.
    writeExtra('orphan-aot-1')
    expect(() => exportMetrics(directory)).toThrow('Unexpected retained launch report orphan-aot-1')

    // An input trial is already a known identity but is not a child launch report.
    const inputName = comparison.inputLaunches[0]!.name
    writeExtra(inputName)
    expect(() => exportMetrics(directory)).toThrow(`Unexpected retained launch report ${inputName}`)

    // The unchanged exporter output remains valid.
    writeFileSync(path, gzipSync(rows.join('\n') + '\n'))
    expect(() => exportMetrics(directory)).not.toThrow()
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

  test('refuses duplicate streaming files while retaining distinct launch samples', () => {
    const { directory } = writeExport()
    const first = join(directory, 'stream-one.json')
    const second = join(directory, 'stream-two.json')
    writeFileSync(first, JSON.stringify(streamingResult('Solid', 'aot')))
    writeFileSync(second, JSON.stringify(streamingResult('Solid', 'aot', 1.1)))
    expect(() => exportMetrics(directory, [first, first])).toThrow('Duplicate streaming result')
    expect(() => exportMetrics(directory, [first, `${directory}/./stream-one.json`])).toThrow(
      'Duplicate streaming result'
    )
    // realpath() alone cannot identify two hard links to one physical result.
    const hardLink = join(directory, 'stream-hard-link.json')
    linkSync(first, hardLink)
    expect(() => exportMetrics(directory, [first, hardLink])).toThrow('Duplicate streaming result')
    const distinct = exportMetrics(directory, [first, second])
    const samples = distinct.metrics['streaming solid/aot frameIntervalP95Ms']!.samples
    expect(samples).toEqual([17, 17 * 1.1])
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
