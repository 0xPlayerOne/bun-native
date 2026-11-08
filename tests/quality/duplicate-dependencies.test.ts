import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  bunDuplicates,
  cargoDuplicates,
  checkDuplicates,
  compareDuplicates,
  main,
} from '../../scripts/quality/duplicate-dependencies.ts'
import { healthSummary, type Check } from '../../scripts/quality/health-summary.ts'

const ROOT = resolve(import.meta.dir, '../..')

const cargo = (packages: [string, string][]) =>
  'version = 4\n\n' +
  packages
    .map(
      ([name, version]) =>
        `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "registry+x"\n`
    )
    .join('\n')

const bun = (packages: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 2,
    workspaces: {},
    packages: Object.fromEntries(
      Object.entries(packages).map(([key, spec]) => [key, [spec, '', {}, 'sha512-x']])
    ),
  }).replace(/}$/, ',}') // bun.lock is JSONC with trailing commas

/** A checkout with all three lockfiles and a record of accepted duplicates. */
function checkout(
  record: object,
  cargoPackages: [string, string][],
  bunPackages: Record<string, string>
) {
  const root = mkdtempSync(join(tmpdir(), 'bun-native-duplicates-'))
  mkdirSync(join(root, 'scripts/quality'), { recursive: true })
  mkdirSync(join(root, 'experiments/native-allocation-api'), { recursive: true })
  writeFileSync(join(root, 'Cargo.lock'), cargo(cargoPackages))
  writeFileSync(join(root, 'experiments/native-allocation-api/Cargo.lock'), cargo([['a', '1.0.0']]))
  writeFileSync(join(root, 'bun.lock'), bun(bunPackages))
  writeFileSync(join(root, 'scripts/quality/duplicate-dependencies.json'), JSON.stringify(record))
  return root
}

describe('duplicate dependency check', () => {
  test('finds Cargo packages resolved at more than one version', () => {
    expect(
      cargoDuplicates(
        cargo([
          ['syn', '2.0.1'],
          ['syn', '3.0.0'],
          ['serde', '1.0.0'],
          ['syn', '2.0.1'],
        ])
      )
    ).toEqual({ syn: ['2.0.1', '3.0.0'] })
    expect(() => cargoDuplicates('[[package]]\nname = "x"\n')).toThrow('lacks a name or version')
  })

  test('finds bun.lock packages at more than one version, including nested and scoped ones, but not workspaces', () => {
    expect(
      bunDuplicates(
        bun({
          '@babel/helper': '@babel/helper@7.29.7',
          'a/@babel/helper': '@babel/helper@7.18.6',
          react: 'react@19.3.0',
          '@bun-native/core': '@bun-native/core@workspace:packages/core',
        })
      )
    ).toEqual({ '@babel/helper': ['7.18.6', '7.29.7'] })
    expect(() => bunDuplicates('{}')).toThrow('no packages map')
    expect(() => bunDuplicates(bun({ x: 'x' }))).toThrow('has resolution x')
  })

  test('a deliberately introduced duplicate fails with the package, versions and a reproduction command', () => {
    const accepted = { 'Cargo.lock': { syn: ['2.0.1', '3.0.0'] }, 'bun.lock': {} }
    const clean = checkout(
      accepted,
      [
        ['syn', '2.0.1'],
        ['syn', '3.0.0'],
      ],
      { react: 'react@19.3.0' }
    )
    expect(checkDuplicates(clean)).toEqual([])
    const dirty = checkout(
      accepted,
      [
        ['syn', '2.0.1'],
        ['syn', '3.0.0'],
        ['rand', '0.8.0'],
        ['rand', '0.9.0'],
      ],
      { react: 'react@19.3.0', 'x/react': 'react@18.0.0' }
    )
    const errors = checkDuplicates(dirty)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('Cargo.lock: new duplicate rand 0.8.0, 0.9.0')
    expect(errors[0]).toContain(
      'cargo tree --locked --manifest-path Cargo.toml -i rand --duplicates'
    )
    expect(errors[1]).toContain('bun.lock: new duplicate react 18.0.0, 19.3.0')
    expect(errors[1]).toContain('bun pm why react')
  })

  test('a recorded duplicate that gains a version, loses one or disappears also fails', () => {
    const record = { 'Cargo.lock': { syn: ['2.0.1', '3.0.0'], old: ['1.0.0', '2.0.0'] } }
    expect(
      compareDuplicates({ 'Cargo.lock': { syn: ['2.0.1', '3.0.0', '4.0.0'] } }, record)
    ).toEqual([
      expect.stringContaining('syn gained a version: 2.0.1, 3.0.0, 4.0.0'),
      expect.stringContaining('old is no longer duplicated'),
    ])
    expect(
      compareDuplicates(
        { 'Cargo.lock': { syn: ['3.0.0', '4.0.0'], old: ['1.0.0', '2.0.0'] } },
        record
      )
    ).toEqual([
      expect.stringContaining('syn gained a version'),
      expect.stringContaining('syn no longer resolves 2.0.1'),
    ])
  })

  test('the committed record matches the real lockfiles', () => {
    expect(checkDuplicates(ROOT)).toEqual([])
  })

  test('the command line reports, fails and rewrites the record', () => {
    const root = checkout(
      {},
      [
        ['syn', '2.0.1'],
        ['syn', '3.0.0'],
      ],
      { react: 'react@19.3.0' }
    )
    const log = console.log
    const error = console.error
    const lines: string[] = []
    console.log = console.error = (line: string) => void lines.push(line)
    try {
      expect(main([], root)).toBe(1)
      expect(main(['--write'], root)).toBe(0)
      expect(
        JSON.parse(readFileSync(join(root, 'scripts/quality/duplicate-dependencies.json'), 'utf8'))
      ).toEqual({
        'Cargo.lock': { syn: ['2.0.1', '3.0.0'] },
        'bun.lock': {},
        'experiments/native-allocation-api/Cargo.lock': {},
      })
      expect(main([], root)).toBe(0)
    } finally {
      console.log = log
      console.error = error
    }
    expect(lines.at(-1)).toContain('match the record (Cargo.lock 1, bun.lock 0')
    expect(() => main([], mkdtempSync(join(tmpdir(), 'bun-native-empty-')))).toThrow()
  })
})

describe('code-health summary', () => {
  const pass: Check = { name: 'Passing', command: 'bun run pass', run: () => [] }

  test('summarizes every check with its result and reproduction command', async () => {
    const result = await healthSummary(ROOT, [pass])
    expect(result.failed).toBe(false)
    expect(result.markdown).toContain('| Passing | clean | `bun run pass` |')
  })

  test('lists the first findings with escaped paths and fails on findings or a check that cannot run', async () => {
    const many: Check = {
      name: 'Boundaries',
      command: 'bun run check:boundaries',
      run: async () =>
        Array.from({ length: 12 }, (_, index) => `packages/a|${index}.ts: reversed edge`),
    }
    const broken: Check = {
      name: 'Broken',
      command: 'bun run broken',
      run: () => {
        throw new Error('no lockfile')
      },
    }
    const one: Check = { name: 'One', command: 'bun run one', run: () => ['x'] }
    const result = await healthSummary(ROOT, [pass, many, broken, one])
    expect(result.failed).toBe(true)
    expect(result.markdown).toContain('| Boundaries | 12 findings | `bun run check:boundaries` |')
    expect(result.markdown).toContain('| One | 1 finding | `bun run one` |')
    expect(result.markdown).toContain('- packages/a\\|0.ts: reversed edge')
    expect(result.markdown).toContain('- ... 2 more; run `bun run check:boundaries`')
    expect(result.markdown).toContain('the check could not run: no lockfile')
  })

  test('the real checkout is clean in every check', async () => {
    const result = await healthSummary(ROOT)
    expect(result.markdown).not.toContain('finding')
    expect(result.failed).toBe(false)
  })
})
