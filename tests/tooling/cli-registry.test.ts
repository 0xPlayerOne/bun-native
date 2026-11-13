import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { registryManifest } from '../../scripts/registry-packages.ts'
import { packageFixture } from './package-fixture.ts'

const repository = resolve(import.meta.dir, '../..')
const workspace: { version: string } = await Bun.file(join(repository, 'package.json')).json()

/** Run a CLI the way a consumer does, from `cwd`, without auto-install. */
async function run(cwd: string, cli: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, '--no-install', cli, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, output: stdout + stderr }
}

/**
 * Stands in for `bun install` of a registry project: the published CLI (the real
 * source closure with its registry package.json) plus the checkout's workspace
 * packages and third-party modules, linked rather than downloaded.
 */
async function installRegistryModules(project: string, cli: Record<string, string>) {
  const modules = join(project, 'node_modules')
  await mkdir(join(modules, '@bun-native'), { recursive: true })
  for (const name of await readdir(join(repository, 'node_modules')))
    if (name !== '@bun-native' && name !== '.bin' && name !== '.cache')
      await symlink(join(repository, 'node_modules', name), join(modules, name))
  for (const name of ['core', 'protocol', 'runtime', 'renderer', 'solid', 'react'])
    await symlink(join(repository, 'packages', name), join(modules, '@bun-native', name))
  for (const [path, text] of Object.entries(cli)) {
    const target = join(modules, '@bun-native/cli', path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text)
  }
}

// The npm-published CLI creates projects outside any checkout. Its package.json
// carries the release's templates, which registry-packages.ts publishes.
test('an npm-installed CLI creates a registry project that checks without a checkout', async () => {
  await packageFixture(
    async ({ directory, set, contents }) => {
      const published = registryManifest(
        set.packages['@bun-native/cli']!.manifest,
        workspace.version,
        set.consumers
      )
      expect(published.bunNative?.templates.solid.dependencies).toEqual({
        '@bun-native/core': workspace.version,
        '@bun-native/solid': workspace.version,
        'solid-js': set.consumers.solid.dependencies['solid-js']!,
      })
      const cli = {
        ...contents['@bun-native/cli']!,
        'package.json': JSON.stringify(published, null, 2) + '\n',
      }
      // `bunx @bun-native/cli create` runs the CLI from a cache outside the new project.
      const tool = join(directory, 'tool')
      await installRegistryModules(tool, cli)
      const entry = join(tool, 'node_modules/@bun-native/cli/src/scripts/native.ts')
      const created = await run(directory, entry, 'create', 'apps/registry-app')
      expect(created.output).toContain('Created solid typescript project')
      expect(created.exitCode).toBe(0)

      const project = join(directory, 'apps/registry-app')
      const manifest = await Bun.file(join(project, 'package.json')).json()
      expect(manifest.dependencies).toEqual(published.bunNative!.templates.solid.dependencies)
      expect(manifest.devDependencies['@bun-native/cli']).toBe(workspace.version)
      expect(manifest.scripts.build).toBe(
        'bun --no-install ./node_modules/@bun-native/cli/src/scripts/native.ts build .'
      )
      expect(await Bun.file(join(project, 'bun-native.json')).json()).toEqual({
        schemaVersion: 1,
        framework: 'solid',
        entry: 'main.tsx',
      })
      expect(existsSync(join(project, 'vendor'))).toBe(false)

      // After install, the project's own CLI serves it: doctor, format and lint.
      await installRegistryModules(project, cli)
      const own = './node_modules/@bun-native/cli/src/scripts/native.ts'
      const doctor = await run(project, own, 'doctor', '.')
      expect(doctor.output).toMatch(/ok\s+project: solid project .* with registry packages/)
      const check = await run(project, own, 'check', '.')
      expect(check.output).toContain('typecheck: passed')
      expect(check.output).toContain('format: passed')
      expect(check.output).toContain('lint: passed')
      expect(check.exitCode).toBe(0)

      // A CLI from a local package set has no registry templates.
      const local = join(directory, 'local')
      await installRegistryModules(local, contents['@bun-native/cli']!)
      const refused = await run(
        directory,
        join(local, 'node_modules/@bun-native/cli/src/scripts/native.ts'),
        'create',
        'apps/other'
      )
      expect(refused.output).toContain('not installed from the npm registry')
      expect(refused.exitCode).not.toBe(0)
    },
    { cli: true }
  )
}, 120_000)
