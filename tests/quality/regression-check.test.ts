import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  compare,
  failed,
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
    const accepted = { mount: { maxRatio: 1.3, adr: 'docs/decisions/0099-tradeoff.md' } }
    const within = compare(
      file({ mount: { samples: around(10) } }, undefined, accepted),
      file({ mount: { samples: around(12) } })
    )
    expect(within.findings[0]).toMatchObject({
      status: 'accepted',
      adr: 'docs/decisions/0099-tradeoff.md',
    })
    expect(failed(within)).toBe(false)
    const beyond = compare(
      file({ mount: { samples: around(10) } }, undefined, accepted),
      file({ mount: { samples: around(14) } })
    )
    expect(beyond.findings[0]!.status).toBe('regressed')
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
      const malformed = run(baseline, write('bad.json', { schemaVersion: 2 }))
      expect(malformed.exitCode).not.toBe(0)
      expect(malformed.stderr.toString()).toContain('schemaVersion must be 1')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
