import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  extractReferences,
  findDeadReferences,
  stripRefFilters,
  workflowSteps,
} from '../../scripts/quality/dead-references.ts'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'bun-native-dead-references-'))
  temporary.push(root)
  for (const [name, source] of Object.entries(files)) {
    const file = join(root, ...name.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await Bun.write(file, source)
  }
  return root
}

describe('dead reference extraction', () => {
  test('finds repository paths and ignores prose, URLs, packages and remote workflows', () => {
    expect(
      extractReferences(
        'bun scripts/build.ts && bun "tests/native/clipboard.ts" --flag=./docs/guide.md ' +
          'https://example.com/docs/page @bun-native/core owner/repo/.github/workflows/x.yml@v1 ' +
          '(see benchmarks/notes.md).'
      )
    ).toEqual([
      'scripts/build.ts',
      'tests/native/clipboard.ts',
      'docs/guide.md',
      'benchmarks/notes.md',
    ])
  })

  test('skips expressions, shell variables and generated output', () => {
    expect(
      extractReferences(
        'cp ${{ runner.temp }}/packages/cli/x tests/native/$fixture.ts ' +
          'packages/core/dist/index.js native/target/release/host ./node_modules/.bin/tool ' +
          '.bun-native/evidence/log.txt scripts/real.ts'
      )
    ).toEqual(['scripts/real.ts'])
  })

  test('treats paths created earlier in the same step as outputs', () => {
    const step = [
      'mkdir -p docs/generated',
      'bun scripts/report.ts > tests/report.txt',
      'bun scripts/report.ts --output benchmarks/out | tee examples/log.txt',
      'cat docs/generated/index.md tests/report.txt benchmarks/out/a.json examples/log.txt',
    ].join('\n')
    expect(extractReferences(step)).toEqual(['scripts/report.ts'])
  })

  test('drops branch and tag filters but keeps path filters', () => {
    const yaml = [
      'on:',
      '  push:',
      '    branches:',
      "      - 'docs/*'",
      '    tags: [docs/v1]',
      '    paths:',
      "      - 'docs/**'",
    ].join('\n')
    const stripped = stripRefFilters(yaml)
    expect(stripped).not.toContain("'docs/*'")
    expect(stripped).not.toContain('docs/v1')
    expect(extractReferences(stripped)).toEqual(['docs/**'])
  })

  test('keeps outputs local to the workflow step that creates them', () => {
    const steps = workflowSteps(
      [
        'steps:',
        '  - name: Create',
        '    run: mkdir -p docs/out',
        '  - name: Use',
        '    run: cat docs/out/a.txt',
      ].join('\n')
    )
    expect(steps.map(extractReferences).flat()).toEqual(['docs/out/a.txt'])
  })
})

describe('dead reference gate', () => {
  test('reports missing paths from scripts, workflows and hooks and accepts live globs', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({
        scripts: { live: 'bun scripts/live.ts', dead: 'bun scripts/missing.ts' },
      }),
      'scripts/live.ts': '',
      'tests/native/a.py': '',
      '.github/workflows/ci.yml': [
        'jobs:',
        '  test:',
        '    steps:',
        '      - uses: ./.github/workflows/gone.yml',
        '      - run: ruff check tests/native/*.py benchmarks/*.py',
      ].join('\n'),
      '.githooks/pre-commit': 'exec bun scripts/live.ts && bun ./tests/hook.ts\n',
    })
    expect(findDeadReferences(root)).toEqual([
      'package.json#scripts.dead: scripts/missing.ts',
      '.github/workflows/ci.yml: .github/workflows/gone.yml',
      '.github/workflows/ci.yml: benchmarks/*.py',
      '.githooks/pre-commit: tests/hook.ts',
    ])
  })

  test('repository scripts, workflows and hooks reference only existing paths', () => {
    expect(findDeadReferences(resolve(import.meta.dir, '../..'))).toEqual([])
  })
})
