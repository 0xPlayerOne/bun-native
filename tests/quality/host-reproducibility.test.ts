import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRecord,
  compareRecords,
  loadRecords,
  main,
  parseRecord,
  parseTools,
  renderMarkdown,
  sha256,
  toolDifferences,
  type Attempt,
  type HostRecord,
} from '../../scripts/quality/host-reproducibility.ts'

const commit = 'a'.repeat(40)
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function record(os: string, attempt: Attempt, host: string, extra: Partial<HostRecord> = {}) {
  return buildRecord({
    os,
    arch: 'X64',
    attempt,
    commit,
    hostFile: 'bun-native-host',
    host: Buffer.from(host),
    archive: Buffer.from(`archive:${host}`),
    tools: { rustc: 'rustc 1.98.1' },
    ...extra,
  })
}

describe('record construction', () => {
  test('hashes the host and its archive', () => {
    const built = record('linux', 'a', 'bytes')
    expect(built.hostSha256).toBe(sha256(Buffer.from('bytes')))
    expect(built.archiveSha256).toBe(sha256(Buffer.from('archive:bytes')))
    expect(built.hostBytes).toBe(5)
    expect(parseRecord(JSON.stringify(built), 'x')).toEqual(built)
  })

  test('rejects malformed inputs', () => {
    expect(() => record('linux', 'c' as Attempt, 'x')).toThrow('attempt must be a or b')
    expect(() => record('linux', 'a', 'x', { commit: 'main' })).toThrow('40-digit')
    expect(() => record('', 'a', 'x')).toThrow('os and arch are required')
    expect(() => record('linux', 'a', '')).toThrow('empty')
  })

  test('parses --tool pairs at the first equals sign and rejects duplicates', () => {
    expect(parseTools(['cc=gcc 13 --version=1', 'sdk='])).toEqual({
      cc: 'gcc 13 --version=1',
      sdk: '',
    })
    expect(() => parseTools(['novalue'])).toThrow('name=value')
    expect(() => parseTools(['=x'])).toThrow('name=value')
    expect(() => parseTools(['a=1', 'a=2'])).toThrow('Duplicate')
  })

  test('rejects stored records that are not exactly the schema', () => {
    const good = record('linux', 'a', 'x')
    for (const [field, value] of [
      ['schemaVersion', 2],
      ['os', ''],
      ['arch', 3],
      ['attempt', 'z'],
      ['commit', 'abc'],
      ['hostSha256', 'F'.repeat(64)],
      ['archiveSha256', 'nope'],
      ['hostBytes', 0],
      ['hostFile', ''],
      ['tools', []],
    ] as const)
      expect(() => parseRecord(JSON.stringify({ ...good, [field]: value }), 'rec.json')).toThrow(
        'rec.json'
      )
  })
})

describe('comparison', () => {
  test('two builds with equal bytes are identical', () => {
    const comparison = compareRecords(
      [record('linux', 'b', 'same'), record('linux', 'a', 'same')],
      ['linux']
    )
    expect(comparison.ok).toBe(true)
    expect(comparison.commit).toBe(commit)
    expect(comparison.results[0]).toMatchObject({
      os: 'linux',
      status: 'identical',
      required: true,
    })
  })

  test('different host bytes fail a required operating system', () => {
    const comparison = compareRecords(
      [record('macos', 'a', 'one'), record('macos', 'b', 'two!')],
      ['macos']
    )
    expect(comparison.ok).toBe(false)
    expect(comparison.results[0]).toMatchObject({ status: 'different' })
    expect(comparison.results[0]?.detail).toContain('vs')
  })

  test('equal hosts with different archives are not reproducible', () => {
    const a = record('linux', 'a', 'same')
    const b = { ...record('linux', 'b', 'same'), archiveSha256: 'b'.repeat(64) }
    const comparison = compareRecords([a, b], ['linux'])
    expect(comparison.ok).toBe(false)
    expect(comparison.results[0]?.detail).toContain('archives differ')
  })

  test('a measured-only operating system reports without gating', () => {
    const comparison = compareRecords(
      [
        record('linux', 'a', 'same'),
        record('linux', 'b', 'same'),
        record('windows', 'a', 'one'),
        record('windows', 'b', 'two'),
      ],
      ['linux']
    )
    expect(comparison.ok).toBe(true)
    expect(comparison.results.map((result) => [result.os, result.status, result.required])).toEqual(
      [
        ['linux', 'identical', true],
        ['windows', 'different', false],
      ]
    )
  })

  test('a missing or repeated attempt is incomplete, never identical', () => {
    expect(compareRecords([record('linux', 'a', 'x')], ['linux']).ok).toBe(false)
    expect(compareRecords([], ['macos']).results[0]).toMatchObject({ status: 'incomplete' })
    const repeated = compareRecords(
      [record('linux', 'a', 'x'), record('linux', 'a', 'x')],
      ['linux']
    )
    expect(repeated.ok).toBe(false)
    expect(repeated.results[0]?.status).toBe('incomplete')
  })

  test('builds from different commits or architectures cannot agree', () => {
    const other = { commit: 'b'.repeat(40) }
    const mixed = compareRecords(
      [record('linux', 'a', 'x'), record('linux', 'b', 'x', other)],
      ['linux']
    )
    expect(mixed.ok).toBe(false)
    expect(mixed.commit).toBeNull()
    const arch = compareRecords(
      [record('linux', 'a', 'x'), record('linux', 'b', 'x', { arch: 'ARM64' })],
      ['linux']
    )
    expect(arch.results[0]?.detail).toContain('architectures')
    expect(arch.ok).toBe(false)
  })
})

describe('reporting', () => {
  test('lists tool differences and renders a table', () => {
    const comparison = compareRecords(
      [
        record('macos', 'a', 'one', { tools: { xcode: '16.4', rustc: 'r1' } }),
        record('macos', 'b', 'two', { tools: { xcode: '16.5', rustc: 'r1' } }),
      ],
      ['macos']
    )
    expect(toolDifferences(comparison.results[0]!)).toEqual(['xcode: 16.4 | 16.5'])
    const text = renderMarkdown(comparison)
    expect(text).toContain('| macos | required | different |')
    expect(text).toContain('Tool or image differences on macos:')
    expect(text).toContain('FAILED')
    expect(toolDifferences({ ...comparison.results[0]!, records: [] })).toEqual([])
    expect(renderMarkdown(compareRecords([], []))).toContain('reproducible')
  })
})

describe('command line', () => {
  test('records two builds, compares them and exits non-zero on a difference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bun-native-host-repro-'))
    temporary.push(root)
    const script = join(import.meta.dir, '../../scripts/quality/host-reproducibility.ts')
    function run(...args: string[]) {
      const lines: string[] = []
      try {
        const code = main(args, (line) => lines.push(line))
        return { out: lines.join('\n'), code }
      } catch (error) {
        return { out: String(error), code: -1 }
      }
    }
    async function recordBuild(attempt: string, bytes: string) {
      const dir = join(root, `record-${attempt}`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'host'), bytes)
      await writeFile(join(dir, 'host.tar.gz'), `archive:${bytes}`)
      const result = run(
        'record',
        '--host',
        join(dir, 'host'),
        '--archive',
        join(dir, 'host.tar.gz'),
        '--out',
        join(dir, `linux-X64-${attempt}.host-record.json`),
        '--os',
        'linux',
        '--arch',
        'X64',
        '--attempt',
        attempt,
        '--commit',
        commit,
        '--tool',
        'rustc=rustc 1.98.1'
      )
      expect(result.code).toBe(0)
      expect(result.out).toContain(`linux/${attempt} host`)
    }
    await recordBuild('a', 'same')
    await recordBuild('b', 'same')
    expect(loadRecords(root).map((loaded) => loaded.attempt)).toEqual(['a', 'b'])
    const output = join(root, 'result.json')
    const ok = run('compare', root, '--require', 'linux', '--output', output)
    expect(ok.code).toBe(0)
    expect(ok.out).toContain('| linux | required | identical |')
    expect((await Bun.file(output).json()).ok).toBe(true)

    await writeFile(join(root, 'record-b', 'host'), 'changed')
    await rm(join(root, 'record-b', 'linux-X64-b.host-record.json'))
    await recordBuild('b', 'changed')
    const bad = run('compare', root, '--require', 'linux')
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('different')

    expect(run('record', '--host', 'relative').out).toContain('--archive is required')
    expect(
      run(
        'record',
        '--host',
        'h',
        '--archive',
        'a',
        '--out',
        'o',
        '--os',
        'linux',
        '--arch',
        'X64',
        '--attempt',
        'a',
        '--commit',
        commit
      ).out
    ).toContain('must be absolute')
    expect(run('compare').out).toContain('usage')
    expect(run('nonsense').code).toBe(-1)
    // The script entry point itself.
    const child = Bun.spawnSync(['bun', script, 'compare', root, '--require', 'linux'])
    expect(child.exitCode).toBe(1)
  })
})
