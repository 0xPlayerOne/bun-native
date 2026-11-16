import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Update = {
  'package-ecosystem': string
  directory: string
  'target-branch'?: string
  'multi-ecosystem-group'?: string
  patterns?: string[]
  groups?: unknown
  ignore?: { 'dependency-name': string; 'update-types'?: string[] }[]
}

const document = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, '..', '..', '.github', 'dependabot.yml'), 'utf8')
) as {
  version: number
  'multi-ecosystem-groups': Record<string, { schedule: { interval: string; day: string } }>
  updates: Update[]
}

test('Dependabot groups the configured ecosystems into one weekly update', () => {
  expect(document.version).toBe(2)
  expect(Object.keys(document['multi-ecosystem-groups'])).toEqual(['dependencies'])
  expect(document['multi-ecosystem-groups']['dependencies']?.schedule).toEqual({
    interval: 'weekly',
    day: 'sunday',
  })
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
    expect(update['target-branch']).toBe('main')
    expect(update.patterns).toEqual(['*'])
    expect(update.groups).toBeUndefined()
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
    '0xPlayerOne/code-foundry*',
  ])
})
