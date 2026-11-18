import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Update = {
  'package-ecosystem': string
  directory: string
  'target-branch'?: string
  'multi-ecosystem-group'?: string
  'open-pull-requests-limit'?: number
  patterns?: string[]
  groups?: unknown
  ignore?: { 'dependency-name': string; 'update-types'?: string[]; versions?: string[] }[]
}

type Document = {
  version: number
  'multi-ecosystem-groups': Record<
    string,
    { schedule: { interval: string; day: string }; 'target-branch'?: string }
  >
  updates: Update[]
}

const document = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, '..', '..', '.github', 'dependabot.yml'), 'utf8')
) as Document

test('Dependabot groups the configured ecosystems into one weekly update', () => {
  expect(document.version).toBe(2)
  expect(Object.keys(document['multi-ecosystem-groups'])).toEqual(['dependencies'])
  expect(document['multi-ecosystem-groups']['dependencies']?.schedule).toEqual({
    interval: 'weekly',
    day: 'sunday',
  })
  // Dependabot rejects `target-branch` on a member of a multi-ecosystem group;
  // the group itself targets main.
  expect(document['multi-ecosystem-groups']['dependencies']?.['target-branch']).toBe('main')
  const expected = [
    ['github-actions', '/'],
    ['bun', '/'],
    ['cargo', '/'],
    ['pip', '/scripts/quality'],
  ]
  expect(document.updates.map((update) => [update['package-ecosystem'], update.directory])).toEqual(
    expected
  )
  for (const update of document.updates) {
    expect(update['multi-ecosystem-group']).toBe('dependencies')
    expect(update['target-branch']).toBeUndefined()
    expect(update.patterns).toEqual(['*'])
    expect(update.groups).toBeUndefined()
  }
})

test('Code Foundry sync preserves the repository-owned Dependabot configuration', () => {
  const root = join(import.meta.dir, '..', '..')
  const configSource = readFileSync(join(root, '.github', 'code-foundry.yml'), 'utf8')
  const config = Bun.YAML.parse(configSource) as {
    features: string
    dependency_updater: string
    billing_paused: boolean
  }
  expect(config.dependency_updater).toBe('dependabot')
  expect(config.features.split(',')).not.toContain('dependabot')
  if (config.billing_paused)
    for (const update of document.updates) expect(update['open-pull-requests-limit']).toBe(0)
  const target = mkdtempSync(join(tmpdir(), 'bun-native-dependabot-sync-'))
  try {
    mkdirSync(join(target, '.github'))
    // The unrelated production CodeQL shard list exceeds this CLI's 512-byte
    // limit. Use a valid shard in the isolated fixture to exercise sync itself.
    writeFileSync(
      join(target, '.github', 'code-foundry.yml'),
      configSource.replace(/^codeql_rust_shards:.*$/m, `codeql_rust_shards: '["all"]'`)
    )
    const dependabot = readFileSync(join(root, '.github', 'dependabot.yml'))
    const destination = join(target, '.github', 'dependabot.yml')
    writeFileSync(destination, dependabot)
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(root, 'node_modules', 'code-foundry', 'src', 'cli.mjs'),
        'sync',
        '--target',
        target,
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' }
    )
    expect(run.stderr.toString()).toBe('')
    expect(run.exitCode).toBe(0)
    expect(readFileSync(destination)).toEqual(dependabot)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('Babel major upgrades remain held without suppressing its patch updates', () => {
  const bun = document.updates.find((update) => update['package-ecosystem'] === 'bun')!
  expect(bun.ignore?.filter((item) => item['dependency-name'] === '@babel/core')).toEqual([
    {
      'dependency-name': '@babel/core',
      'update-types': ['version-update:semver-major'],
    },
  ])
  const actions = document.updates.find(
    (update) => update['package-ecosystem'] === 'github-actions'
  )!
  expect(actions.ignore?.map((item) => item['dependency-name'])).toEqual([
    'AndrewM-F/code-foundry*',
  ])
})

test('GPUI-bound incompatible versions remain held until coordinated upgrade', () => {
  const cargo = document.updates.find((update) => update['package-ecosystem'] === 'cargo')!
  expect(cargo.ignore).toEqual([
    { 'dependency-name': 'accesskit', versions: ['>= 0.25.0'] },
    { 'dependency-name': 'accesskit_consumer', versions: ['>= 0.39.0'] },
    { 'dependency-name': 'base64', versions: ['>= 0.23.0'] },
    { 'dependency-name': 'xkbcommon', versions: ['>= 0.9.0'] },
    { 'dependency-name': 'x11rb', versions: ['>= 0.14.0'] },
  ])
})
