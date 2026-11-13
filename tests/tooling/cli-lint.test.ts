import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import rootManifest from '../../package.json'
import installedLinter from '../../node_modules/oxlint/package.json'
import { lockedPackages } from '../../scripts/native/package-lock.ts'
import {
  cliSourceClosure,
  consumerDefinitions,
  materializedManifests,
} from '../../scripts/native/package-source.ts'
import { createProject, readProject, type Project } from '../../scripts/native/project.ts'
import { lintArguments, lintProject, templateLinterConfig } from '../../scripts/native/lint.ts'

const repository = resolve(import.meta.dir, '../..')
const cli = join(repository, 'scripts/native.ts')
const debuggerFile = 'export function pause() {\n  debugger\n}\n'
const debuggerReport =
  'bad.ts:2:3: `debugger` statement is not allowed [Error/eslint(no-debugger)]\n\n1 problem\n'

// Checkout projects inherit the root .gitignore, so these fixtures live in an owned,
// non-ignored directory inside the checkout, like the other CLI quality tests.
async function fixture(exercise: (directory: string) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(repository, '.cli-lint-'))
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

describe('native lint (real pinned oxlint)', () => {
  test('all four generated templates pass lint out of the box through the CLI and their script', async () => {
    await fixture(async (directory) => {
      for (const framework of ['solid', 'react'] as const)
        for (const language of ['typescript', 'javascript'] as const) {
          const project = join(directory, `${framework} ${language}`)
          await createProject(repository, project, framework, language)
          const pkg = await Bun.file(join(project, 'package.json')).json()
          expect(pkg.scripts.lint).toEndWith(' lint .')
          const direct = run([cli, 'lint', project])
          expect(direct.stderr).toBe('')
          expect(direct.stdout).toBe('lint: passed\n')
          expect(direct.code).toBe(0)
          const script = run(['run', 'lint'], project)
          expect(script.code).toBe(0)
          expect(script.stdout).toBe('lint: passed\n')
        }
    })
  }, 60_000)

  test('a deliberately bad file fails lint and check with a deterministic report and status 1', async () => {
    await fixture(async (directory) => {
      const project = join(directory, 'bad app')
      await createProject(repository, project, 'react', 'typescript')
      writeFileSync(join(project, 'bad.ts'), debuggerFile)
      const lint = run([cli, 'lint', project])
      expect(lint.code).toBe(1)
      expect(lint.stdout).toBe(debuggerReport + 'lint: failed\n')
      expect(lint.stderr).toBe('')
      // The report is stable across runs: no timings, colours or absolute paths.
      expect(run([cli, 'lint', project]).stdout).toBe(lint.stdout)

      // Well-typed and formatted, so check reports only the lint step as failed.
      const check = run([cli, 'check', project])
      expect(check.code).toBe(1)
      expect(check.stdout).toContain('typecheck: passed')
      expect(check.stdout).toContain('format: passed')
      expect(check.stdout).toEndWith(debuggerReport + 'lint: failed\n')
      expect(check.stderr).toBe('')
    })
  }, 60_000)

  test('generated output and installed dependencies are never linted', async () => {
    await fixture(async (directory) => {
      const project = join(directory, 'outputs')
      await createProject(repository, project, 'solid', 'typescript')
      for (const generated of ['dist', '.bun-native/dev-1', 'node_modules/example']) {
        mkdirSync(join(project, generated), { recursive: true })
        writeFileSync(join(project, generated, 'bad.ts'), debuggerFile)
      }
      // Remove the project .gitignore so the explicit CLI patterns alone exclude the output.
      rmSync(join(project, '.gitignore'))
      const result = run([cli, 'lint', project])
      expect(result.stdout).toBe('lint: passed\n')
      expect(result.code).toBe(0)
    })
  }, 30_000)

  test('a project .oxlintrc.json replaces the template rules', async () => {
    await fixture(async (directory) => {
      const project = join(directory, 'configured')
      await createProject(repository, project, 'solid', 'javascript')
      writeFileSync(join(project, 'legacy.js'), 'export var legacy = 1\n')
      const loaded = await readProject(repository, project)
      expect(lintArguments(loaded)).toContain(templateLinterConfig)
      expect((await lintProject(loaded)).exitCode).toBe(0)
      writeFileSync(
        join(project, '.oxlintrc.json'),
        JSON.stringify({ rules: { 'no-var': 'error' } }) + '\n'
      )
      expect(lintArguments(loaded)).not.toContain(templateLinterConfig)
      const step = await lintProject(loaded)
      expect(step.exitCode).toBe(1)
      expect(step.output).toContain('legacy.js:1:8:')
      expect(step.output).toContain('eslint(no-var)')
    })
  }, 30_000)

  test('a standalone project never lints its digest-verified vendor package set', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'bun-native-lint-')))
    try {
      writeFileSync(join(directory, 'main.ts'), 'export const value = 1\n')
      mkdirSync(join(directory, 'vendor/bun-native'), { recursive: true })
      writeFileSync(join(directory, 'vendor/bun-native/bad.ts'), debuggerFile)
      const unpackaged: Project = {
        directory,
        framework: 'solid',
        entry: join(directory, 'main.ts'),
      }
      const standalone: Project = {
        ...unpackaged,
        packageSet: {
          source: { commit: '1'.repeat(40), tree: '2'.repeat(40) },
          manifest: { bytes: 0, sha256: '0'.repeat(64) },
        },
      }
      expect(lintArguments(unpackaged)).not.toContain('vendor/**')
      expect(lintArguments(standalone)).toContain('vendor/**')
      expect(await lintProject(standalone)).toMatchObject({ name: 'lint', exitCode: 0, output: '' })
      const linted = await lintProject(unpackaged)
      expect(linted.exitCode).toBe(1)
      expect(linted.output).toContain('vendor/bun-native/bad.ts:2:3:')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test('rejects missing or extra project operands and unknown options', () => {
    for (const args of [['lint'], ['lint', 'a', 'b'], ['lint', '.', '--fix']]) {
      const result = run([cli, ...args])
      expect(result.code).toBe(1)
      expect(result.stderr.length).toBeGreaterThan(0)
    }
  })
})

describe('oxlint pin', () => {
  test('the packaged CLI, standalone consumers and the checkout share the one oxlint pin', async () => {
    const pin = rootManifest.devDependencies.oxlint
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/)
    expect(installedLinter.version).toBe(pin)
    const closure = await cliSourceClosure(repository)
    expect(closure.files).toContain('.oxlintrc.json')
    expect(closure.external).toContain('oxlint')
    const manifests = await materializedManifests(repository, closure.external)
    expect(manifests['@bun-native/cli']!.dependencies!['oxlint']).toBe(pin)
    const consumers = await consumerDefinitions(repository, manifests)
    const lock = lockedPackages(
      Bun.JSONC.parse(await Bun.file(join(repository, 'bun.lock')).text())
    )
    for (const framework of ['solid', 'react'] as const) {
      expect(consumers[framework].devDependencies['oxlint']).toBe(pin)
      expect(consumers[framework].lock.packages['oxlint']![0]).toBe(`oxlint@${pin}`)
      // Every platform binding stays locked; the installer selects the current one.
      const bindings = Object.keys(lock.packages).filter((name) =>
        name.startsWith('@oxlint/binding-')
      )
      expect(bindings.length).toBeGreaterThan(0)
      for (const binding of bindings)
        expect(consumers[framework].lock.packages[binding]![0]).toBe(`${binding}@${pin}`)
    }
  })
})
