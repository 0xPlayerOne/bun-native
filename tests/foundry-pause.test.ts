import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  BILLING_GUARD,
  PAUSED_BILLING_GUARD,
  guardWorkflow,
  syncFoundry,
  verifyGithubLayout,
} from '../scripts/sync-foundry.ts'

const job = (condition: string): string =>
  `jobs:\n  run:\n    if: ${condition}\n    runs-on: ubuntu-latest\n    steps:\n      - if: failure()\n        run: echo preserve me\n`

describe('checked-in CI billing pause', () => {
  test('requires an explicit remote false while paused and is reversible', () => {
    const source = job(BILLING_GUARD)
    const paused = guardWorkflow(source, true)
    expect(paused).toBe(job(PAUSED_BILLING_GUARD))
    expect(guardWorkflow(paused, true)).toBe(paused)
    expect(guardWorkflow(paused, false)).toBe(source)
    // An absent repository variable resolves to empty text, not an opt-in.
    for (const value of ['', 'true', 'paused']) expect(value === 'false').toBe(false)
    expect(PAUSED_BILLING_GUARD).toBe("vars.CI_BILLING_PAUSED == 'false'")
  })
  test('preserves every existing predicate and all job steps', () => {
    const predicate =
      " && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')"
    const source = job(BILLING_GUARD + predicate)
    expect(guardWorkflow(source, true)).toBe(job(PAUSED_BILLING_GUARD + predicate))
  })
  test('retains folded YAML conditions and their formatting', () => {
    const source = `jobs:\n  scan:\n    if: >-\n      ${BILLING_GUARD} &&\n      needs.detect.outputs.enabled == 'true'\n    uses: owner/repo/.github/workflows/scan.yml@v1\n`
    const paused = guardWorkflow(source, true)
    expect(paused).toBe(source.replace(BILLING_GUARD, PAUSED_BILLING_GUARD))
    expect(guardWorkflow(paused, true)).toBe(paused)
  })
  test('cannot accept a guard bypassed by a top-level OR', () => {
    for (const suffix of [' || true', " && github.event_name == 'push' || true"]) {
      expect(() => guardWorkflow(job(BILLING_GUARD + suffix), true)).toThrow(
        'Review the existing condition'
      )
    }
  })
  test('quoted operators and escaped single quotes are not mistaken for ORs', () => {
    for (const suffix of [" && contains('a||b', 'a')", " && contains('it''s (valid)', '(')"]) {
      expect(guardWorkflow(job(BILLING_GUARD + suffix), true)).toBe(
        job(PAUSED_BILLING_GUARD + suffix)
      )
    }
  })
  test('rejects unmatched delimiters instead of assuming a safe condition', () => {
    for (const suffix of [' && (true', ' && true)', " && 'unterminated"]) {
      expect(() => guardWorkflow(job(BILLING_GUARD + suffix), true)).toThrow()
    }
  })
  test('new custom jobs receive the same paused default', () => {
    const source =
      'jobs:\n  later-milestone:\n    runs-on: windows-2022\n    steps:\n      - run: bun test\n'
    expect(guardWorkflow(source, true)).toContain(`    if: ${PAUSED_BILLING_GUARD}\n`)
  })
  test('all current workflows roundtrip pause/resume without changing job bodies', async () => {
    const config = Bun.YAML.parse(
      await readFile(resolve(import.meta.dir, '../.github/code-foundry.yml'), 'utf8')
    ) as { billing_paused: boolean }
    const directory = resolve(import.meta.dir, '../.github/workflows')
    for (const name of await readdir(directory)) {
      if (!/\.ya?ml$/.test(name)) continue
      const source = await readFile(resolve(directory, name), 'utf8')
      expect(
        guardWorkflow(guardWorkflow(source, !config.billing_paused), config.billing_paused),
        name
      ).toBe(source)
    }
  })
})

describe('sync destination preflight', () => {
  test('rejects the misspelled directory before invoking upstream or writing .github', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'bunly-foundry-preflight-'))
    try {
      await mkdir(resolve(root, '.guthub'))
      await expect(syncFoundry(root)).rejects.toThrow('Misplaced GitHub content')
      expect(await readdir(root)).toEqual(['.guthub'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test('detects nested misplaced directories below workflows, not just the first level', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'bunly-foundry-nested-'))
    try {
      await mkdir(resolve(root, '.github/workflows/.github'), { recursive: true })
      await expect(verifyGithubLayout(root)).rejects.toThrow('Nested')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test('detects case collisions in nested GitHub directories', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'bunly-foundry-case-'))
    try {
      const workflows = resolve(root, '.github/workflows')
      await mkdir(workflows, { recursive: true })
      await writeFile(resolve(workflows, 'ci.yml'), 'first')
      await writeFile(resolve(workflows, 'CI.yml'), 'second')
      if ((await readdir(workflows)).length === 2)
        await expect(verifyGithubLayout(root)).rejects.toThrow('Case-colliding')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test.skipIf(process.platform === 'win32')(
    'rejects linked output paths before upstream can follow them',
    async () => {
      const root = await mkdtemp(resolve(tmpdir(), 'bunly-foundry-link-'))
      try {
        const outside = resolve(root, 'outside')
        await mkdir(outside)
        await symlink(outside, resolve(root, '.github'))
        await expect(syncFoundry(root)).rejects.toThrow('Linked .github')
        expect(await readdir(outside)).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
