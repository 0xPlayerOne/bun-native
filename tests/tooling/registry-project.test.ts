import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import toolchain from '../../toolchain.json'
import {
  installedTemplates,
  registryFiles,
  registryTemplates,
} from '../../scripts/native/registry-project.ts'

const consumers = {
  solid: {
    dependencies: { '@bun-native/core': 'file:../core', 'solid-js': '1.9.9' },
    devDependencies: { '@bun-native/cli': 'file:../cli', typescript: '5.9.3' },
  },
  react: {
    dependencies: { '@bun-native/react': 'file:../react', react: '19.2.0' },
    devDependencies: { '@bun-native/cli': 'file:../cli', '@types/react': '19.2.2' },
  },
}

let directory = ''
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bun-native-registry-project-'))
})
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('published templates pin every @bun-native package to the release and keep other pins', () => {
  const templates = registryTemplates(consumers, '1.2.3')
  expect(templates.solid).toEqual({
    dependencies: { '@bun-native/core': '1.2.3', 'solid-js': '1.9.9' },
    devDependencies: { '@bun-native/cli': '1.2.3', typescript: '5.9.3' },
  })
  expect(templates.react.dependencies).toEqual({ '@bun-native/react': '1.2.3', react: '19.2.0' })
  expect(templates.react.devDependencies['@types/react']).toBe('19.2.2')
})

test('an installed CLI reads its templates from its own package.json', async () => {
  const templates = registryTemplates(consumers, '1.2.3')
  const installed = join(directory, 'installed')
  await mkdir(join(installed, 'src'), { recursive: true })
  await writeFile(join(installed, 'package.json'), JSON.stringify({ bunNative: { templates } }))
  expect(await installedTemplates(join(installed, 'src'))).toEqual(templates)
})

test('a CLI without complete templates refuses to create a registry project', async () => {
  for (const [name, manifest] of [
    ['none', {}],
    ['partial', { bunNative: { templates: { solid: consumers.solid } } }],
  ] as const) {
    const local = join(directory, name)
    await mkdir(join(local, 'src'), { recursive: true })
    await writeFile(join(local, 'package.json'), JSON.stringify(manifest))
    await expect(installedTemplates(join(local, 'src'))).rejects.toThrow(
      'not installed from the npm registry'
    )
  }
})

test('registry project files pin the toolchain and carry the template dependencies', () => {
  const template = registryTemplates(consumers, '1.2.3').solid
  const files = registryFiles(template, 'solid', 'main.tsx', 'demo')
  expect(Object.keys(files).sort()).toEqual([
    '.gitignore',
    'README.md',
    'bun-native.json',
    'package.json',
    'tsconfig.json',
  ])
  expect(JSON.parse(files['bun-native.json']!)).toEqual({
    schemaVersion: 1,
    framework: 'solid',
    entry: 'main.tsx',
  })
  const manifest = JSON.parse(files['package.json']!)
  expect(manifest).toMatchObject({
    name: 'demo',
    private: true,
    type: 'module',
    packageManager: `bun@${toolchain.bun.version}`,
    engines: { bun: toolchain.bun.version },
    dependencies: template.dependencies,
    devDependencies: template.devDependencies,
  })
  expect(files['.gitignore']).toBe('dist/\n.bun-native/\nnode_modules/\n')
  expect(files['README.md']).toContain('Bun Native 1.2.3 packages')
  expect(files['README.md']).toContain('/blob/v1.2.3/docs/getting-started.md')
})
