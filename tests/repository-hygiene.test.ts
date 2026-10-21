import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  FOUNDRY_SOURCE,
  FOUNDRY_VERSION,
  customizeBugReport,
  pinFoundryWorkflow,
  syncFoundry,
  verifyFoundryState,
  verifyGithubLayout,
} from '../scripts/sync-foundry.ts'

const root = resolve(import.meta.dir, '..')

for (const name of [
  'CONTRIBUTING.md',
  'contributing.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'PULL_REQUEST_TEMPLATE.md',
  'pull_request_template',
  '.GITHUB',
]) {
  test(`Foundry rejects misplaced ${name} before upstream writes`, async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'bunly-layout-'))
    try {
      await writeFile(resolve(directory, name), 'authored content')
      await expect(syncFoundry(directory)).rejects.toThrow()
      expect(await readdir(directory)).toEqual([name])
      expect(await readFile(resolve(directory, name), 'utf8')).toBe('authored content')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('case-insensitive duplicate issue form names are rejected', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'bunly-forms-'))
  try {
    const forms = resolve(directory, '.github/ISSUE_TEMPLATE')
    await mkdir(forms, { recursive: true })
    await writeFile(resolve(forms, 'old.yml'), 'name: Bug report\nbody: []\n')
    await writeFile(resolve(forms, 'new.yml'), 'name: BUG REPORT\nbody: []\n')
    await expect(verifyGithubLayout(directory)).rejects.toThrow('Duplicate issue form')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reviewed Foundry workflow and runtime pins are immutable and idempotent', () => {
  const source = `jobs:\n  check:\n    uses: 0xPlayerOne/code-foundry/.github/workflows/validation.yml@v${FOUNDRY_VERSION}\n    with:\n      runtime-ref: v${FOUNDRY_VERSION}\n`
  const pinned = pinFoundryWorkflow(source)
  expect(pinned).toContain('@' + FOUNDRY_SOURCE)
  expect(pinned).toContain('runtime-ref: ' + FOUNDRY_SOURCE)
  expect(pinFoundryWorkflow(pinned)).toBe(pinned)
  expect(() => pinFoundryWorkflow(source.replaceAll(`v${FOUNDRY_VERSION}`, 'main'))).toThrow(
    'Unreviewed Code Foundry'
  )
  expect(() => pinFoundryWorkflow(source.replaceAll(`v${FOUNDRY_VERSION}`, 'v9.9.9'))).toThrow()
})

test('bug form customization preserves platform-specific diagnostics after sync', () => {
  const source =
    'description: Include the commit, branch, runtime/tool versions, operating system, and affected app or package.\n'
  const changed = customizeBugReport(source)
  expect(changed).toContain('developer and packaged Bun')
  expect(changed).toContain('security profile')
  expect(customizeBugReport(changed)).toBe(changed)
})

test('the actual checkout has one canonical policy layout and the reviewed Foundry overlay', async () => {
  await verifyFoundryState(root)
  const guide = await readFile(resolve(root, '.github/CONTRIBUTING.md'), 'utf8')
  expect(guide).toContain('## Bunly development setup')
  expect(guide).toContain('code-foundry-managed: agent-operating-contract')
  const validation = Bun.YAML.parse(
    await readFile(resolve(root, '.github/workflows/validation.yml'), 'utf8')
  ) as {
    jobs: Record<string, { steps?: { with?: { repository?: string; ref?: string } }[] }>
  }
  const checkouts = Object.values(validation.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.with?.repository === '0xPlayerOne/code-foundry')
  expect(checkouts).toHaveLength(1)
  expect(checkouts[0]!.with?.ref).toBe(FOUNDRY_SOURCE)
})

test('all external Actions and reusable workflows are pinned to complete commit identities', async () => {
  const directory = resolve(root, '.github/workflows')
  for (const file of await readdir(directory)) {
    if (!/\.ya?ml$/.test(file)) continue
    const source = await readFile(resolve(directory, file), 'utf8')
    for (const match of source.matchAll(/^\s*(?:- )?uses:\s+(\S+)/gm)) {
      const action = match[1]!
      if (action.startsWith('./')) continue
      expect(action, `${file}: ${action}`).toMatch(/@[a-f0-9]{40}$/)
    }
  }
})

test('obsolete toolchain snapshot and weaker CEF smoke runner stay removed', async () => {
  const workflow = await readFile(resolve(root, '.github/workflows/cef-runtime.yml'), 'utf8')
  expect(workflow).not.toContain('contributor-snapshot:')
  expect(workflow).not.toContain('rust-toolchain.tgz')
  expect(workflow).not.toContain('qualify-cef-runtime.ts')
  expect(await Bun.file(resolve(root, 'scripts/qualify-cef-runtime.ts')).exists()).toBe(false)
  const automatic = workflow.slice(workflow.indexOf('  cef:'), workflow.indexOf('  manual-plan:'))
  expect(automatic).toContain('hosted_cef.py run --suite smoke')
  expect(automatic).toContain('hosted-windows.ps1 -Suite smoke')
  expect(automatic).toContain('build --locked')
  expect(automatic).not.toContain('if: always()')
})
