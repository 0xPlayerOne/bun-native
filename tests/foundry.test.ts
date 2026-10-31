import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  BILLING_GUARD,
  FOUNDRY_SOURCE,
  PAUSED_BILLING_GUARD,
  MANUAL_DISPATCH_GUARD,
  UPSTREAM_RELEASE_BYPASS_GUARD,
  dependabotDirectories,
  guardWorkflow,
  verifyGithubLayout,
} from '../scripts/sync-foundry.ts'
const root = resolve(import.meta.dir, '..')
function yaml(source: string): Record<string, unknown> {
  return Bun.YAML.parse(source) as Record<string, unknown>
}

describe('Code Foundry installation', () => {
  test('keeps an exact development-only package and matching released runtime', async () => {
    const pkg = await Bun.file(resolve(root, 'package.json')).json()
    const config = yaml(await readFile(resolve(root, '.github/code-foundry.yml'), 'utf8'))
    expect(pkg.devDependencies['code-foundry']).toBe('1.48.8')
    expect(pkg.dependencies?.['code-foundry']).toBeUndefined()
    expect(config['runtime_ref']).toBe(FOUNDRY_SOURCE)
    expect(config['package_manager']).toBe('bun')
    expect(config['profile']).toBe('monorepo')
    expect(config['languages']).toBe('typescript,rust,python')
  })
  test('keeps publishing opt-in and the existing license intact', async () => {
    const config = yaml(await readFile(resolve(root, '.github/code-foundry.yml'), 'utf8'))
    expect(config['npm_publish']).toBe(false)
    expect(String(config['features']).split(',')).toContain('release')
    expect(config['license']).toBe('preserve')
    expect(await readFile(resolve(root, 'LICENSE'), 'utf8')).toStartWith('MIT License')
    const agents = await readFile(resolve(root, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('# Bun Native — autonomous implementation instructions')
    expect(agents).toContain('code-foundry-managed: pull-request-policy')
  })
  test('places generated content in .github with only one case-safe PR template', async () => {
    await verifyGithubLayout(root)
    const names = await readdir(resolve(root, '.github'))
    expect(names.filter((name) => name.toLowerCase() === 'pull_request_template.md')).toEqual([
      'PULL_REQUEST_TEMPLATE.md',
    ])
    expect(await readFile(resolve(root, '.github/CODEOWNERS'), 'utf8')).toContain('* @0xPlayerOne')
  })
  test('automatic jobs honor the pause; only the explicit manual lane is independent', async () => {
    const config = yaml(await readFile(resolve(root, '.github/code-foundry.yml'), 'utf8'))
    const guard = config['billing_paused'] === true ? PAUSED_BILLING_GUARD : BILLING_GUARD
    const directory = resolve(root, '.github/workflows')
    for (const file of (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name))) {
      const workflow = yaml(await readFile(resolve(directory, file), 'utf8'))
      const jobs = workflow['jobs'] as Record<string, Record<string, unknown>>
      for (const [name, job] of Object.entries(jobs)) {
        if (file === 'cef-runtime.yml' && ['manual-plan', 'manual-native'].includes(name)) {
          expect(job['if']).toBe(MANUAL_DISPATCH_GUARD)
          expect(Object.hasOwn(workflow['on'] as object, 'workflow_dispatch')).toBe(true)
        } else expect(String(job['if']), `${file}/${name}`).toStartWith(guard)
      }
    }
  })
  test('release jobs cannot override the CI billing pause through dispatch input', async () => {
    const upstream = `name: Release\non:\n  workflow_dispatch:\n    inputs:\n      release-while-paused:\n        type: boolean\njobs:\n  release:\n    if: ${UPSTREAM_RELEASE_BYPASS_GUARD}\n    runs-on: ubuntu-latest\n`
    expect(guardWorkflow(upstream, true)).toContain(`if: ${PAUSED_BILLING_GUARD}`)
    expect(guardWorkflow(upstream, true)).not.toContain("inputs['release-while-paused']")
  })
  test('pauses all updater ecosystems and selects actual independent manifest roots', async () => {
    const config = yaml(await readFile(resolve(root, '.github/code-foundry.yml'), 'utf8'))
    expect(typeof config['billing_paused']).toBe('boolean')
    const updates = yaml(await readFile(resolve(root, '.github/dependabot.yml'), 'utf8'))[
      'updates'
    ] as Record<string, unknown>[]
    for (const entry of updates) {
      if (config['billing_paused']) {
        expect(entry['open-pull-requests-limit']).toBe(0)
        expect((entry['schedule'] as Record<string, unknown>)['interval']).toBe('monthly')
      } else {
        expect(Number(entry['open-pull-requests-limit'])).toBeGreaterThan(0)
      }
    }
    expect(
      updates.find((entry) => entry['package-ecosystem'] === 'cargo')?.['directories']
    ).toEqual(['/native', '/native/cef-host'])
    expect(updates.find((entry) => entry['package-ecosystem'] === 'bun')?.['directories']).toEqual([
      '/',
      '/benchmarks/adapters/electron',
      '/benchmarks/adapters/electrobun',
      '/benchmarks/fixtures',
    ])
    for (const manifest of [
      'native/Cargo.toml',
      'native/cef-host/Cargo.toml',
      'requirements-dev.txt',
    ]) {
      expect(await Bun.file(resolve(root, manifest)).exists()).toBe(true)
    }
  })
  test('runs the installed hook through Bun and preserves machine-hook chaining', async () => {
    const hook = await readFile(resolve(root, '.githooks/pre-commit'), 'utf8')
    expect(hook).toContain('exec bun --bun code-foundry pre-commit')
    expect(hook).toContain('CODE_FOUNDRY_HOOK_CHAIN=1')
    expect(hook).not.toContain('exec node_modules/.bin/code-foundry pre-commit')
  })
})

describe('Code Foundry overlay', () => {
  test('guards jobs without modifying their steps, triggers, or permissions', () => {
    const source =
      'name: example\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n  native:\n    runs-on: macos-15\n    steps:\n      - run: cargo test\n'
    const guarded = guardWorkflow(source)
    const actual = yaml(guarded)
    const original = yaml(source)
    const jobs = actual['jobs'] as Record<string, Record<string, unknown>>
    for (const job of Object.values(jobs)) {
      expect(job['if']).toBe(BILLING_GUARD)
      delete job['if']
    }
    expect(actual).toEqual(original)
    expect(guardWorkflow(guarded)).toBe(guarded)
  })
  test('refuses to silently overwrite an authored job condition', () => {
    expect(() =>
      guardWorkflow(
        'jobs:\n  run:\n    if: github.ref == "refs/heads/main"\n    runs-on: ubuntu-latest\n'
      )
    ).toThrow('Review the existing condition')
  })
  test('preserves generated billing-aware conditions', () => {
    const source = `jobs:\n  run:\n    if: ${BILLING_GUARD} && github.event_name == 'push'\n    runs-on: ubuntu-latest\n`
    expect(guardWorkflow(source)).toBe(source)
  })
  test('changes only updater directories and retains upstream pause controls', () => {
    const source = `version: 2
updates:
  - package-ecosystem: cargo
    directory: /
    open-pull-requests-limit: 0 # paused
  - package-ecosystem: bun
    directory: /
    open-pull-requests-limit: 0 # paused
    ignore:
      # TypeScript 7 (the native compiler) is supported by the oxlint/oxfmt
      # toolchain; the tsconfig must use NodeNext or bundler resolution since
      # legacy node10 resolution was removed. Held with 5.9 until each
      # repository's tsconfig is verified on 7.`
    const output = dependabotDirectories(source)
    expect(output).toContain('    open-pull-requests-limit: 0 # paused')
    expect(output).not.toContain('    directory: /\n')
    expect(output).toContain('      - /native/cef-host')
    expect(output).toContain(
      "TypeScript 7 (the native compiler) is supported by Bun's type checker"
    )
    expect(output).not.toContain('oxfmt')
  })
  test('fails closed on upstream template layout changes', () => {
    expect(() =>
      dependabotDirectories('updates:\n  - package-ecosystem: cargo\n    directory: /somewhere\n')
    ).toThrow('Unexpected upstream cargo layout')
  })
  test('rejects misplaced, nested, and case-colliding GitHub content', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'bunly-foundry-layout-'))
    try {
      await mkdir(resolve(directory, '.guthub'))
      await expect(verifyGithubLayout(directory)).rejects.toThrow('Misplaced GitHub content')
      await rm(resolve(directory, '.guthub'), { recursive: true })
      await mkdir(resolve(directory, '.github/.github'), { recursive: true })
      await expect(verifyGithubLayout(directory)).rejects.toThrow('Nested')
      await rm(resolve(directory, '.github/.github'), { recursive: true })
      // Real case collisions are only constructible on a case-sensitive filesystem.
      await writeFile(resolve(directory, '.github/example'), 'a')
      await writeFile(resolve(directory, '.github/EXAMPLE'), 'b')
      if ((await readdir(resolve(directory, '.github'))).length === 2) {
        await expect(verifyGithubLayout(directory)).rejects.toThrow('Case-colliding')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
