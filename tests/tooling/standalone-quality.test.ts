import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { lintArguments, lintProject } from '../../scripts/native/lint.ts'
import { createProject, readProject } from '../../scripts/native/project.ts'
import { formatProject } from '../../scripts/native/quality.ts'
import { installedFixture, packageFixture } from './package-fixture.ts'

const repository = resolve(import.meta.dir, '../..')

describe('generated standalone projects (inert installed package fixture)', () => {
  test('all four pass the format check and lint as generated, and lint never reads vendor/', async () => {
    await packageFixture(async ({ directory, manifest, set, contents }) => {
      for (const framework of ['solid', 'react'] as const)
        for (const language of ['typescript', 'javascript'] as const) {
          const project = join(directory, `${framework} ${language}`)
          await createProject(repository, project, framework, language, manifest)
          const pkg = await Bun.file(join(project, 'package.json')).json()
          expect(pkg.scripts.lint).toBe(
            'bun --no-install ./node_modules/@bun-native/cli/src/scripts/native.ts lint .'
          )
          expect(pkg.devDependencies.oxlint).toBe(set.consumers[framework].devDependencies.oxlint)
          await installedFixture(project, set, framework, contents)
          const loaded = await readProject(repository, project)
          const format = formatProject(loaded, true)
          expect(format.output).toContain('All matched files use the correct format.')
          expect(format.exitCode).toBe(0)
          // A lintable file inside the digest-verified package set is still never linted.
          writeFileSync(
            join(project, 'vendor/bun-native/unlinted.js'),
            'export function pause() {\n  debugger\n}\n'
          )
          expect(lintArguments(loaded)).toContain('vendor/**')
          expect(lintProject(loaded)).toMatchObject({ name: 'lint', exitCode: 0, output: '' })
        }
    })
  }, 60_000)
})
