import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Group = {
  patterns?: string[]
  'exclude-patterns'?: string[]
  'applies-to'?: string
}
type Update = {
  'package-ecosystem': string
  directory: string
  groups?: Record<string, Group>
  ignore?: { 'dependency-name': string; 'update-types'?: string[] }[]
}

const document = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, '..', '..', '.github', 'dependabot.yml'), 'utf8')
) as { version: number; updates: Update[] }

function updateFor(ecosystem: string): Update {
  const matches = document.updates.filter(
    (update) => update['package-ecosystem'] === ecosystem && update.directory === '/'
  )
  expect(matches).toHaveLength(1)
  return matches[0]!
}

// The configured groups use '*' plus literal exclusions. This is a policy
// assertion for those exact patterns, not a replacement for Dependabot's matcher.
function includedInGroup(group: Group, dependency: string): boolean {
  return (
    group.patterns?.includes('*') === true &&
    group['exclude-patterns']?.includes(dependency) !== true
  )
}

test('Dependabot isolates all incompatible compiler and native upgrades', () => {
  expect(document.version).toBe(2)
  for (const { ecosystem, groupName, isolated, companions } of [
    {
      ecosystem: 'bun',
      groupName: 'bun-dependencies',
      isolated: ['@babel/core'],
      companions: ['oxc-parser', 'oxlint'],
    },
    {
      ecosystem: 'cargo',
      groupName: 'cargo-dependencies',
      // #578 failed duplicate-identity checks for all three direct upgrades;
      // AccessKit also caused actual GPUI/host Rust type errors.
      isolated: ['accesskit', 'base64', 'x11rb'],
      companions: ['serde', 'log'],
    },
  ]) {
    const update = updateFor(ecosystem)
    const group = update.groups?.[groupName]
    expect(group).toBeDefined()
    expect(group!.patterns).toEqual(['*'])
    expect(group!['applies-to']).toBe('version-updates')
    expect(group!['exclude-patterns']).toEqual(isolated)
    for (const dependency of isolated) {
      expect(includedInGroup(group!, dependency)).toBe(false)
      // Negative control: deleting any one exclusion restores that dependency
      // to the catch-all group; this assertion detects partial regressions.
      expect(
        includedInGroup(
          { ...group!, 'exclude-patterns': isolated.filter((item) => item !== dependency) },
          dependency
        )
      ).toBe(true)
      // Isolation must not hide upgrade notices behind Dependabot ignore policy.
      expect(update.ignore?.some((item) => item['dependency-name'] === dependency) ?? false).toBe(
        dependency === '@babel/core'
      )
    }
    for (const companion of companions) expect(includedInGroup(group!, companion)).toBe(true)
  }
})

test('Babel major upgrades remain held without suppressing its patch updates', () => {
  const bun = updateFor('bun')
  expect(bun.ignore?.filter((item) => item['dependency-name'] === '@babel/core')).toEqual([
    {
      'dependency-name': '@babel/core',
      'update-types': ['version-update:semver-major'],
    },
  ])
  expect(
    updateFor('cargo').ignore?.some((item) => item['dependency-name'] === 'accesskit')
  ).not.toBe(true)
})
