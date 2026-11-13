import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { hostArchive } from '../../scripts/native/host-archive.ts'
import { releaseHostAsset, type ReleaseHostTarget } from '../../scripts/native/host-download.ts'
import { cliContext, releaseVersion, userHostCache } from '../../scripts/native/context.ts'
import { stampFile } from '../../scripts/native/package-stamp.ts'
import { createProject } from '../../scripts/native/project.ts'
import { hostHeader } from './host-fixture.ts'
import { installedFixture, packageFixture } from './package-fixture.ts'

const repository = resolve(import.meta.dir, '../..')
const workspace: { version: string } = await Bun.file(join(repository, 'package.json')).json()

describe('CLI context', () => {
  let directory: string
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'bun-native-cli-context-'))
  })
  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  test('a checkout reads the workspace version and caches hosts in the checkout', async () => {
    const context = await cliContext(repository)
    expect(context).toEqual({
      mode: 'checkout',
      root: repository,
      version: workspace.version,
      hostCache: join(repository, '.bun-native', 'hosts'),
      command: 'bun run native',
    })
  })

  test('an installed CLI reads its own manifest and caches hosts in the user cache', async () => {
    const project = join(directory, 'consumer')
    const cli = join(project, 'node_modules', '@bun-native', 'cli')
    await mkdir(join(cli, 'src'), { recursive: true })
    await writeFile(
      join(cli, 'package.json'),
      JSON.stringify({ name: '@bun-native/cli', version: '7.8.9' })
    )
    const context = await cliContext(join(cli, 'src'), { XDG_CACHE_HOME: join(directory, 'xdg') })
    expect(context.mode).toBe('package')
    expect(context.version).toBe('7.8.9')
    // Never the project: its .bun-native/ holds only dev modules.
    expect(context.hostCache).toBe(join(directory, 'xdg', 'bun-native', 'hosts'))
    expect(context.command).toContain('./node_modules/@bun-native/cli/src/scripts/native.ts')
  })

  test('a package-set bootstrap CLI uses the user cache, never its own directory', async () => {
    const cli = join(directory, 'set', 'cli')
    await mkdir(join(cli, 'src'), { recursive: true })
    await writeFile(
      join(cli, 'package.json'),
      JSON.stringify({ name: '@bun-native/cli', version: '1.0.0' })
    )
    const context = await cliContext(join(cli, 'src'), { XDG_CACHE_HOME: join(directory, 'xdg') })
    expect(context.hostCache).toBe(join(directory, 'xdg', 'bun-native', 'hosts'))
    await writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@bun-native/cli' }))
    const unversioned = await cliContext(join(cli, 'src'))
    expect(() => releaseVersion(unversioned)).toThrow('pass host install --version')
    expect(releaseVersion(unversioned, '1.2.3')).toBe('1.2.3')
  })

  test('the user cache follows each platform convention', () => {
    const home = `${sep}home${sep}me`
    expect(userHostCache({}, 'linux', home)).toBe(join(home, '.cache', 'bun-native', 'hosts'))
    expect(userHostCache({}, 'darwin', home)).toBe(
      join(home, 'Library', 'Caches', 'bun-native', 'hosts')
    )
    expect(userHostCache({ LOCALAPPDATA: join(home, 'L') }, 'win32', home)).toBe(
      join(home, 'L', 'bun-native', 'hosts')
    )
    expect(userHostCache({}, 'win32', home)).toBe(
      join(home, 'AppData', 'Local', 'bun-native', 'hosts')
    )
  })

  test('a bare copy of the CLI sources has no release version', async () => {
    const context = await cliContext(join(directory, 'empty'))
    expect(context.version).toBeUndefined()
    expect(() => releaseVersion(context)).toThrow('has no package version')
  })
})

const supported =
  ['linux', 'darwin'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch)

describe.skipIf(!supported)('packaged CLI released host (consumer layout)', () => {
  test('host install and --host auto cache in the project and keep the installed CLI verifiable', async () => {
    const target = `${process.platform}-${process.arch}` as ReleaseHostTarget
    const archive = hostArchive(
      [
        {
          name: 'bun-native-host',
          data: hostHeader(process.platform as 'linux' | 'darwin', process.arch as 'x64' | 'arm64'),
        },
      ],
      1_700_000_000
    )
    const sums = `${createHash('sha256').update(archive).digest('hex')}  ${releaseHostAsset(target)}\n`
    const requests: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        requests.push(path)
        if (path === `/v${workspace.version}/SHA256SUMS`) return new Response(sums)
        if (path === `/v${workspace.version}/${releaseHostAsset(target)}`)
          return new Response(archive)
        return new Response('missing', { status: 404 })
      },
    })
    try {
      await packageFixture(
        async ({ directory, manifest, set, contents }) => {
          const project = join(directory, 'consumer')
          const cacheHome = join(directory, 'user-cache')
          await createProject(repository, project, 'solid', 'typescript', manifest)
          await installedFixture(project, set, 'solid', contents)
          // Asynchronous: the release server runs in this process.
          const run = async (...args: string[]) => {
            const child = Bun.spawn(
              [
                process.execPath,
                '--no-install',
                './node_modules/@bun-native/cli/src/scripts/native.ts',
                ...args,
              ],
              {
                cwd: project,
                env: {
                  ...process.env,
                  BUN_NATIVE_HOST_RELEASE_URL: server.url.href,
                  XDG_CACHE_HOME: cacheHome,
                },
                stdout: 'pipe',
                stderr: 'pipe',
                timeout: 30_000,
              }
            )
            const [stdout, stderr, exitCode] = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ])
            const output = stdout + stderr
            if (exitCode !== 0) throw new Error(`${args.join(' ')} failed:\n${output}`)
            return output
          }
          const installed = join(
            cacheHome,
            'bun-native',
            'hosts',
            `v${workspace.version}`,
            target,
            'bun-native-host'
          )
          expect(await run('--help')).toContain('bun --no-install ./node_modules/@bun-native/cli/')
          expect((await run('host', 'install')).trim()).toBe(installed)
          expect(requests).toHaveLength(2)
          expect(await run('doctor', '--host', 'auto', '.')).toMatch(
            /ok\s+host: .*\n.*ok\s+project: solid project .* with verified installed package set/
          )
          expect(requests).toHaveLength(2) // reused from the user cache
          expect(await run('format', '.', '--check')).toContain('format: passed')
          // The second light command reuses the verification stamp the first one left.
          expect(existsSync(stampFile(project, { XDG_CACHE_HOME: cacheHome }))).toBe(true)
          // The project keeps no CLI state: .bun-native/ is only for dev modules.
          expect(existsSync(join(project, '.bun-native'))).toBe(false)
          expect(await run('format', '.', '--check')).toContain('format: passed')
          const cli = join(project, 'node_modules', '@bun-native', 'cli')
          expect(existsSync(join(cli, '.bun-native'))).toBe(false)
          expect(readdirSync(join(cli, 'src')).sort()).not.toContain('.bun-native')
        },
        { cli: true }
      )
    } finally {
      server.stop(true)
    }
  }, 60_000)
})
