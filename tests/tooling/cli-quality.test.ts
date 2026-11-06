import { describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import toolchain from '../../toolchain.json'
import { diagnose } from '../../scripts/native/doctor.ts'
import { createProject, readProject } from '../../scripts/native/project.ts'
import { cliSourceClosure } from '../../scripts/native/package-source.ts'
import {
  checkProject,
  formatArguments,
  formatProject,
  templateFormatterConfig,
} from '../../scripts/native/quality.ts'
import { hostHeader } from './host-fixture.ts'

const repository = resolve(import.meta.dir, '../..')
const cli = join(repository, 'scripts/native.ts')

// Checkout projects inherit the root formatter config and .gitignore, which exclude the usual
// .bun-native/dist/build caches, so these fixtures live in an owned, non-ignored directory.
async function fixture(exercise: (directory: string) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(repository, '.cli-quality-'))
  try {
    await exercise(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function run(args: string[], cwd = repository) {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe('native check and format (real built-in checker and formatter)', () => {
  for (const [framework, language] of [
    ['solid', 'typescript'],
    ['react', 'javascript'],
  ] as const) {
    test(`${framework} ${language}: generated project passes, then each failure is reported`, async () => {
      await fixture(async (directory) => {
        const project = join(directory, 'quality app')
        await createProject(repository, project, framework, language)
        const entry = join(project, language === 'typescript' ? 'main.tsx' : 'main.jsx')
        const original = readFileSync(entry, 'utf8')

        const clean = run([cli, 'check', project])
        expect(clean.stderr).toBe('')
        expect(clean.code).toBe(0)
        expect(clean.stdout).toContain('typecheck: passed')
        expect(clean.stdout).toContain('format: passed')
        expect(run(['run', 'format:check'], project).code).toBe(0)

        // Well-typed but unformatted: only the formatter step fails.
        appendFileSync(entry, 'export const   spaced = [1,2]\n')
        const unformatted = run([cli, 'check', project])
        expect(unformatted.code).toBe(1)
        expect(unformatted.stdout).toContain('typecheck: passed')
        expect(unformatted.stdout).toContain('format: failed')
        expect(unformatted.stderr).toContain('Apply formatting')
        expect(run(['run', 'format:check'], project).code).toBe(1)
        expect(readFileSync(entry, 'utf8')).toContain('export const   spaced')

        const formatted = run(['run', 'format'], project)
        expect(formatted.code).toBe(0)
        expect(readFileSync(entry, 'utf8')).toBe(original + 'export const spaced = [1, 2]\n')
        expect(run([cli, 'check', project]).code).toBe(0)

        // Formatted but ill-typed: only the type-check step fails, and both steps still run.
        appendFileSync(
          entry,
          language === 'typescript'
            ? "export const wrong: number = 'text'\n"
            : "/** @type {number} */\nexport const wrong = 'text'\n"
        )
        const illTyped = run([cli, 'check', project])
        expect(illTyped.code).toBe(1)
        expect(illTyped.stdout).toContain('typecheck: failed')
        expect(illTyped.stdout).toContain('TS2322')
        expect(illTyped.stdout).toContain('format: passed')
        expect(illTyped.stderr).toBe('')
      })
    }, 60_000)
  }

  test('a project formatter config takes precedence over the template style', async () => {
    await fixture(async (directory) => {
      const project = join(directory, 'styled')
      await createProject(repository, project, 'solid', 'typescript')
      const loaded = await readProject(repository, project)
      expect(formatArguments(loaded, true)).not.toContain('--config')
      writeFileSync(join(project, '.oxfmtrc.json'), JSON.stringify({ semi: true }) + '\n')
      const result = run([cli, 'format', project, '--check'])
      expect(result.code).toBe(1)
      expect(result.stdout).toContain('format: failed')
    })
  }, 30_000)

  test('a project without any formatter config uses the CLI template style', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'bun-native-format-')))
    try {
      await fixture(async (checkout) => {
        const generated = join(checkout, 'source')
        await createProject(repository, generated, 'react', 'typescript')
        copyFileSync(join(generated, 'main.tsx'), join(directory, 'main.tsx'))
      })
      const project = { directory, framework: 'react' as const, entry: join(directory, 'main.tsx') }
      const args = formatArguments(project, true)
      expect(args.slice(args.indexOf('--config'), args.indexOf('--config') + 2)).toEqual([
        '--config',
        templateFormatterConfig,
      ])
      expect(args).not.toContain('vendor/**')
      expect(formatProject(project, true).exitCode).toBe(0)
      // Standalone package archives are digest-verified, so the formatter never touches them.
      const standalone = {
        ...project,
        packageSet: {
          source: { commit: '1'.repeat(40), tree: '2'.repeat(40) },
          manifest: { bytes: 0, sha256: '0'.repeat(64) },
        },
      }
      mkdirSync(join(directory, 'vendor/bun-native'), { recursive: true })
      writeFileSync(join(directory, 'vendor/bun-native/manifest.json'), '{"a":   1}\n')
      expect(formatArguments(standalone, true)).toContain('vendor/**')
      expect(formatProject(standalone, true).exitCode).toBe(0)
      expect(formatProject(project, true).exitCode).toBe(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test('the template formatter config is packaged with the CLI source closure', async () => {
    expect((await cliSourceClosure(repository)).files).toContain('.oxfmtrc.json')
  })

  test('rejects missing or extra operands and unknown options', () => {
    for (const args of [
      ['check'],
      ['check', 'a', 'b'],
      ['format', '.', '--write'],
      ['doctor', 'a', 'b'],
    ]) {
      const result = run([cli, ...args])
      expect(result.code).toBe(1)
      expect(result.stderr.length).toBeGreaterThan(0)
    }
  })
})

describe('native doctor (no host is launched)', () => {
  test('reports pinned Bun, platform, a matching host header and a checkout project', async () => {
    await fixture(async (directory) => {
      const host = join(directory, 'header-only-host')
      writeFileSync(host, hostHeader(process.platform as 'linux', process.arch as 'x64'))
      chmodSync(host, 0o755)
      const project = join(directory, 'doctor app')
      await createProject(repository, project, 'solid', 'typescript')
      const result = run([cli, 'doctor', project, '--host', host])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/^ok {6}bun: pinned revision /m)
      expect(result.stdout).toContain(`ok      platform: ${process.platform}-${process.arch}`)
      expect(result.stdout).toContain('(protocol handshake not run)')
      expect(result.stdout).toContain('ok      project: solid project')
    })
  }, 30_000)

  test('fails on a mismatched host, a relative host and an invalid project', async () => {
    await fixture(async (directory) => {
      const other = process.arch === 'x64' ? 'arm64' : 'x64'
      const host = join(directory, 'wrong-arch-host')
      writeFileSync(host, hostHeader(process.platform as 'linux', other))
      chmodSync(host, 0o755)
      const project = join(directory, 'broken')
      mkdirSync(project)
      writeFileSync(join(project, 'bun-native.json'), '{"schemaVersion": 2}\n')
      const mismatched = run([cli, 'doctor', project, '--host', host])
      expect(mismatched.code).toBe(1)
      expect(mismatched.stdout).toContain(
        `failed  host: Prebuilt host must be a ${process.platform}`
      )
      expect(mismatched.stdout).toContain(
        'failed  project: bun-native.json requires schemaVersion 1'
      )
      const relative = run([cli, 'doctor', '--host', 'bun-native-host'])
      expect(relative.code).toBe(1)
      expect(relative.stdout).toContain('failed  host: --host must be an absolute path')
      expect(relative.stdout).toContain('skipped project')
      const bare = run([cli, 'doctor'])
      expect(bare.code).toBe(0)
      expect(bare.stdout).toContain('skipped host')
    })
  }, 30_000)
})

describe('diagnose (in process)', () => {
  test('skips the optional host and project checks when neither is given', async () => {
    expect(await diagnose(repository, {})).toEqual([
      { name: 'bun', status: 'ok', detail: `pinned revision ${toolchain.bun.cliRevision}` },
      {
        name: 'platform',
        status: 'ok',
        detail: `${process.platform}-${process.arch} has a pinned Bun distribution`,
      },
      {
        name: 'host',
        status: 'skipped',
        detail: 'pass --host /absolute/path/to/bun-native-host to check a prebuilt host',
      },
      { name: 'project', status: 'skipped', detail: 'pass a project directory' },
    ])
  })

  test('reports a readable matching host and a checkout project as ok', async () => {
    await fixture(async (directory) => {
      const host = join(directory, 'header-only-host')
      writeFileSync(host, hostHeader(process.platform as 'linux', process.arch as 'x64'))
      chmodSync(host, 0o755)
      const project = join(directory, 'doctor app')
      await createProject(repository, project, 'react', 'javascript')
      const [, , hostResult, projectResult] = await diagnose(repository, { host, project })
      expect(hostResult).toEqual({
        name: 'host',
        status: 'ok',
        detail: `${realpathSync(host)} is a readable ${process.platform}/${process.arch} executable (protocol handshake not run)`,
      })
      expect(projectResult).toEqual({
        name: 'project',
        status: 'ok',
        detail: `react project ${realpathSync(project)} in this checkout`,
      })
    })
  }, 30_000)

  test('turns host and project errors into failed lines instead of throwing', async () => {
    await fixture(async (directory) => {
      const [, , hostResult, projectResult] = await diagnose(repository, {
        host: 'bun-native-host',
        project: join(directory, 'missing'),
      })
      expect(hostResult?.status).toBe('failed')
      expect(hostResult?.detail).toContain('--host must be an absolute path')
      expect(projectResult?.status).toBe('failed')
      expect(projectResult?.detail).toContain('ENOENT')
    })
  })

  test('fails an unpinned Bun revision and a platform without a pinned distribution', async () => {
    const { revision, packages } = toolchain.bun
    const target = `${process.platform}-${process.arch}`
    // The imported JSON module is shared, so swap and restore its fields rather than mocking modules.
    toolchain.bun.revision = '0'.repeat(40)
    toolchain.bun.packages = Object.fromEntries(
      Object.entries(packages).filter(([key]) => key !== target)
    ) as typeof packages
    try {
      const [bun, platform] = await diagnose(repository, {})
      expect(bun).toEqual({
        name: 'bun',
        status: 'failed',
        detail: `running ${Bun.version} (${Bun.revision}); dev, build and package sets require ${toolchain.bun.cliRevision} from toolchain.json`,
      })
      expect(platform).toEqual({
        name: 'platform',
        status: 'failed',
        detail: `${target} has no pinned Bun distribution; supported: ${Object.keys(packages)
          .filter((key) => key !== target)
          .join(', ')}`,
      })
    } finally {
      toolchain.bun.revision = revision
      toolchain.bun.packages = packages
    }
    expect((await diagnose(repository, {})).slice(0, 2).map((result) => result.status)).toEqual([
      'ok',
      'ok',
    ])
  })
})

describe('checkProject (in process)', () => {
  test('runs type checking then formatting and reports both steps', async () => {
    await fixture(async (directory) => {
      const project = join(directory, 'in process')
      await createProject(repository, project, 'solid', 'typescript')
      const steps = checkProject(await readProject(repository, project))
      expect(steps.map((step) => step.name)).toEqual(['typecheck', 'format'])
      expect(steps.map((step) => step.exitCode)).toEqual([0, 0])
      expect(steps[0]!.command).toContain('check')
    })
  }, 60_000)
})
