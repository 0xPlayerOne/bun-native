import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  compare,
  failed,
  parseMetrics,
  summary,
  type Metric,
  type MetricsFile,
} from '../../scripts/quality/regression-check.ts'

const repository = resolve(import.meta.dir, '../..')

function file(
  metrics: Record<string, Partial<Metric> & { samples: number[] }>,
  label = 'linux-x64 4 cpu',
  accepted?: MetricsFile['accepted']
): MetricsFile {
  return {
    schemaVersion: 1,
    environment: { label },
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([name, metric]) => [
        name,
        { unit: 'ms', direction: 'lower' as const, reproduce: `bun bench ${name}`, ...metric },
      ])
    ),
    ...(accepted ? { accepted } : {}),
  }
}

const around = (center: number, spread = 0.02) =>
  Array.from({ length: 12 }, (_, i) => center * (1 + spread * ((i % 5) - 2)))

describe('metric regression gate', () => {
  test('flags a stable 20% slowdown with the metric, ratio and reproduction command', () => {
    const result = compare(
      file({ mount: { samples: around(10) } }),
      file({ mount: { samples: around(12) } })
    )
    expect(result.findings[0]).toMatchObject({ name: 'mount', status: 'regressed' })
    expect(result.findings[0]!.ratio).toBeCloseTo(1.2, 1)
    expect(failed(result)).toBe(true)
    expect(summary(result)).toContain('Reproduce mount: `bun bench mount`')
  })

  test('does not fail on noise-level movement or on an improvement', () => {
    const result = compare(
      file({ a: { samples: around(10) }, b: { samples: around(10) } }),
      file({ a: { samples: around(10.4) }, b: { samples: around(7) } })
    )
    expect(result.findings.map((f) => f.status)).toEqual(['unchanged', 'improved'])
    expect(failed(result)).toBe(false)
  })

  test('an overlapping noisy slowdown is suspected but not failed', () => {
    const noisy = [5, 20, 8, 25, 6, 22, 9, 24, 7, 21, 10, 23]
    const result = compare(
      file({ tail: { samples: noisy } }),
      file({ tail: { samples: noisy.map((x) => x * 1.15) } })
    )
    expect(result.findings[0]!.status).toBe('suspected')
    expect(failed(result)).toBe(false)
  })

  test('a throughput metric is worse when it falls', () => {
    const result = compare(
      file({ rate: { direction: 'higher', unit: 'rows/s', samples: around(1000) } }),
      file({ rate: { direction: 'higher', unit: 'rows/s', samples: around(800) } })
    )
    expect(result.findings[0]).toMatchObject({ status: 'regressed' })
    expect(result.findings[0]!.ratio).toBeCloseTo(1.25, 1)
  })

  test('fewer than three samples cannot prove a regression but is reported', () => {
    const result = compare(
      file({ rss: { samples: [10, 10] } }),
      file({ rss: { samples: [14, 14] } })
    )
    expect(result.findings[0]!.status).toBe('suspected')
    expect(result.findings[0]!.note).toContain('fewer than three')
  })

  test('a missing metric or an empty run fails closed', () => {
    const result = compare(
      file({ a: { samples: around(1) }, b: { samples: around(1) } }),
      file({ b: { samples: [] } })
    )
    expect(result.findings.map((f) => f.status)).toEqual(['missing', 'unmeasured'])
    expect(failed(result)).toBe(true)
  })

  test('samples from different hardware are never compared', () => {
    const result = compare(
      file({ a: { samples: around(10) } }, 'linux-x64 4 cpu'),
      file({ a: { samples: around(10) } }, 'darwin-arm64 8 cpu')
    )
    expect(result.comparable).toBe(false)
    expect(failed(result)).toBe(true)
    expect(summary(result)).toContain('NOT COMPARABLE')
  })

  test('a tradeoff recorded with an ADR is accepted only up to its bound', () => {
    const accepted = { mount: { maxRatio: 1.3, adr: 'docs/decisions/0011-owned-processes.md' } }
    const within = compare(
      file({ mount: { samples: around(10) } }, undefined, accepted),
      file({ mount: { samples: around(12) } })
    )
    expect(within.findings[0]).toMatchObject({
      status: 'accepted',
      adr: 'docs/decisions/0011-owned-processes.md',
    })
    expect(failed(within)).toBe(false)
    const beyond = compare(
      file({ mount: { samples: around(10) } }, undefined, accepted),
      file({ mount: { samples: around(14) } })
    )
    expect(beyond.findings[0]!.status).toBe('regressed')
  })

  test('direct comparisons reject malformed accepted tradeoffs without JSON parsing', () => {
    const current = file({ mount: { samples: around(13) } })
    for (const accepted of [
      { maxRatio: '100' as unknown as number, adr: '' },
      { maxRatio: Infinity, adr: 'docs/decisions/0011-owned-processes.md' },
      { maxRatio: 1.4, adr: 'docs/decisions/9999-nonexistent-decision.md' },
    ]) {
      const baseline = file({ mount: { samples: around(10) } }, undefined, { mount: accepted })
      expect(() => compare(baseline, current)).toThrow(/accepted mount/)
    }
  })

  test('direct comparisons cannot silently accept a wrong schema or unlabelled environment', () => {
    const baseline = file({ mount: { samples: around(10) } })
    const current = file({ mount: { samples: around(10) } })
    // These two invalid schema inputs used to yield a passing unchanged comparison.
    expect(failed(compare(baseline, current))).toBe(false)
    for (const which of ['baseline', 'current'] as const) {
      const malformed = structuredClone(which === 'baseline' ? baseline : current)
      ;(malformed as { schemaVersion: number }).schemaVersion = 2
      expect(() =>
        compare(which === 'baseline' ? malformed : baseline, which === 'current' ? malformed : current)
      ).toThrow(new RegExp(`${which}: schemaVersion`))
    }
    // Reject missing metadata before computing comparability.
    const noLabel = structuredClone(current)
    noLabel.environment.label = ''
    expect(() => compare(baseline, noLabel)).toThrow(/current: environment\\.label/)
    expect(() => parseMetrics('null', 'baseline')).toThrow(/metrics file must be an object/)
  })

  test('a baseline with a zero median cannot define a ratio', () => {
    const result = compare(
      file({ rss: { samples: [0, 0, 0] } }),
      file({ rss: { samples: [5, 5, 5] } })
    )
    expect(result.findings[0]).toMatchObject({ status: 'unmeasured', ratio: null })
    expect(failed(result)).toBe(true)
  })

  test('metrics files are validated before comparison', () => {
    const valid = JSON.stringify(file({ a: { samples: [1, 2, 3] } }))
    expect(parseMetrics(valid, 'x').metrics['a']!.samples).toEqual([1, 2, 3])
    const broken = (change: (value: any) => void) => {
      const value = JSON.parse(valid)
      change(value)
      return JSON.stringify(value)
    }
    expect(() =>
      parseMetrics(
        broken((v) => (v.schemaVersion = 2)),
        'x'
      )
    ).toThrow(/schemaVersion/)
    expect(() =>
      parseMetrics(
        broken((v) => (v.environment.label = '')),
        'x'
      )
    ).toThrow(/environment\.label/)
    expect(() =>
      parseMetrics(
        broken((v) => (v.metrics.a.samples = [1, 'x'])),
        'x'
      )
    ).toThrow(/finite numeric samples/)
    expect(() =>
      parseMetrics(
        broken((v) => (v.metrics.a.direction = 'up')),
        'x'
      )
    ).toThrow(/direction/)
  })

  test('a metric whose unit or direction changed is never compared', () => {
    const baseline = file({ a: { samples: [100, 100, 100] } })
    for (const change of [
      { unit: 's', samples: [1, 1, 1] },
      { direction: 'higher' as const, samples: [1, 1, 1] },
      { unit: 's', direction: 'higher' as const, samples: [1, 1, 1] },
    ]) {
      const result = compare(baseline, file({ a: change }))
      expect(result.findings.map((f) => f.status)).toEqual(['unmeasured'])
      expect(result.findings[0]!.ratio).toBeNull()
      expect(result.findings[0]!.note).toMatch(/unit or direction/)
      expect(failed(result)).toBe(true)
    }
    // The same unit and direction still compare as before.
    expect(failed(compare(baseline, file({ a: { samples: [100, 100, 100] } })))).toBe(false)
  })

  test('a comparison with no baseline metric fails closed instead of passing', () => {
    const empty = file({})
    expect(failed(compare(empty, file({ a: { samples: around(1) } })))).toBe(true)
    expect(failed(compare(empty, empty))).toBe(true)
  })

  test('metrics files need at least one well-formed metric', () => {
    const text = (change: (value: any) => void) => {
      const value = JSON.parse(JSON.stringify(file({ a: { samples: [1, 2, 3] } })))
      change(value)
      return JSON.stringify(value)
    }
    expect(() =>
      parseMetrics(
        text((v) => (v.metrics = {})),
        'x'
      )
    ).toThrow(/at least one metric/)
    expect(() =>
      parseMetrics(
        text((v) => delete v.metrics),
        'x'
      )
    ).toThrow(/at least one metric/)
    expect(() =>
      parseMetrics(
        text((v) => (v.metrics.a.unit = '')),
        'x'
      )
    ).toThrow(/unit/)
    expect(() =>
      parseMetrics(
        text((v) => delete v.metrics.a.unit),
        'x'
      )
    ).toThrow(/unit/)
    expect(() =>
      parseMetrics(
        text((v) => (v.metrics.a = null)),
        'x'
      )
    ).toThrow(/a/)
  })

  test('invalid accepted tradeoff metadata cannot exempt a regression', () => {
    const original = JSON.parse(
      JSON.stringify(
        file({ mount: { samples: around(10) } }, 'linux-x64 4 cpu', {
          mount: { maxRatio: 1.3, adr: 'docs/decisions/0011-owned-processes.md' },
        })
      )
    )
    expect(parseMetrics(JSON.stringify(original), 'baseline').accepted?.mount?.maxRatio).toBe(1.3)
    const invalid: Array<(value: any) => void> = [
      (v) => (v.accepted = null),
      (v) => (v.accepted.mount = null),
      (v) => (v.accepted.mount.maxRatio = '100'),
      (v) => (v.accepted.mount.maxRatio = 1),
      (v) => (v.accepted.mount.maxRatio = null),
      (v) => (v.accepted.mount.adr = ''),
      (v) => (v.accepted.mount.adr = '../unreviewed.md'),
      (v) => (v.accepted.mount.adr = 'docs/decisions/9999-nonexistent-decision.md'),
      (v) =>
        (v.accepted.missing = {
          maxRatio: 100,
          adr: 'docs/decisions/0011-owned-processes.md',
        }),
    ]
    for (const corrupt of invalid) {
      const value = structuredClone(original)
      corrupt(value)
      expect(() => parseMetrics(JSON.stringify(value), 'baseline')).toThrow(/accepted/)
    }
  })

  test('invalid comparison thresholds cannot suppress a stable regression', () => {
    const baseline = file({ mount: { samples: around(10) } })
    const slower = file({ mount: { samples: around(13) } })
    expect(failed(compare(baseline, slower))).toBe(true)
    for (const threshold of [Number.NaN, Infinity, -Infinity, 0, -0.1])
      expect(() => compare(baseline, slower, { threshold })).toThrow(/threshold/)
  })

  test('the command line exits non-zero on a regression and rejects malformed files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'regression-check-'))
    try {
      const write = (name: string, value: unknown) => {
        const path = join(directory, name)
        writeFileSync(path, JSON.stringify(value))
        return path
      }
      const run = (...args: string[]) =>
        Bun.spawnSync([process.execPath, 'scripts/quality/regression-check.ts', ...args], {
          cwd: repository,
          stdout: 'pipe',
          stderr: 'pipe',
        })
      const baseline = write('baseline.json', file({ mount: { samples: around(10) } }))
      const slow = write('slow.json', file({ mount: { samples: around(13) } }))
      const same = write('same.json', file({ mount: { samples: around(10) } }))
      const failing = run(baseline, slow)
      expect(failing.exitCode).toBe(1)
      expect(failing.stdout.toString()).toContain('regressed')
      expect(run(baseline, same).exitCode).toBe(0)
      // Number('1e309') is Infinity. Without validation, this suppresses
      // even a statistically stable slowdown by making every bound infinite.
      for (const invalid of ['Infinity', '1e309']) {
        const bypass = run(baseline, slow, '--threshold', invalid)
        expect(bypass.exitCode).not.toBe(0)
        expect(bypass.stderr.toString()).toContain('usage: regression-check.ts')
      }
      // Before validation, the string "100" was coerced by <= and suppressed
      // a proven 30% slowdown, even though its ADR reference was blank.
      const invalidAcceptance = write(
        'unreviewed.json',
        file({ mount: { samples: around(10) } }, 'linux-x64 4 cpu', {
          mount: { maxRatio: '100' as unknown as number, adr: '' },
        })
      )
      const bypass = run(invalidAcceptance, slow)
      expect(bypass.exitCode).not.toBe(0)
      expect(bypass.stderr.toString()).toContain('accepted mount.maxRatio')
      const malformed = run(baseline, write('bad.json', { schemaVersion: 2 }))
      expect(malformed.exitCode).not.toBe(0)
      expect(malformed.stderr.toString()).toContain('schemaVersion must be 1')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
