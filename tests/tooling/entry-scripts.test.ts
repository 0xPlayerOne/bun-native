import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Command-line contracts of entry scripts that other suites only reach through
// subprocesses (or not at all). Every case here fails before any build, package,
// download or parser work starts, so no fixture outside a temporary directory changes.
const repository = resolve(import.meta.dir, '../..')
const script = (path: string) => join(repository, 'scripts', path)
const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function run(command: string[], env: Record<string, string | undefined> = process.env) {
  const result = Bun.spawnSync(command, {
    cwd: repository,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  })
  expect(result.signalCode ?? null).toBeNull()
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

const bun = (path: string, ...args: string[]) => run([process.execPath, script(path), ...args])

describe('scripts/native.ts command parsing', () => {
  const header = 'Bun Native application tooling'

  test('prints usage on stdout and succeeds for no arguments, --help and -h', () => {
    for (const args of [[], ['--help'], ['-h']]) {
      const result = bun('native.ts', ...args)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.startsWith(header)).toBe(true)
      for (const command of ['create', 'dev', 'build']) expect(result.stdout).toContain(command)
      expect(result.stdout).toContain('No command downloads a host or runs Cargo.')
    }
  })

  test('rejects unknown commands with the usage text on stderr', () => {
    for (const args of [['frob'], ['--help', 'extra']]) {
      const result = bun('native.ts', ...args)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toStartWith(`Unknown command: ${args[0]}\n${header}`)
    }
  })

  test('requires exactly one project directory for every command', () => {
    const cases: [string[], string][] = [
      [['create'], 'create requires exactly one new project directory'],
      [['create', 'one', 'two'], 'create requires exactly one new project directory'],
      [['dev'], 'dev requires exactly one project directory'],
      [['build', 'one', 'two'], 'build requires exactly one project directory'],
    ]
    for (const [args, message] of cases) {
      const result = bun('native.ts', ...args)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`${message}\n`)
    }
  })

  test('parses options strictly per command', () => {
    for (const args of [
      ['create', 'app', '--bogus'],
      ['dev', 'app', '--outdir', 'dist'],
      ['dev', 'app', '--host-profile', 'dev'],
      ['build', 'app', '--watch'],
    ]) {
      const result = bun('native.ts', ...args)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('Unknown option')
    }
  })
})

describe('scripts/install-bun.mjs argument contract', () => {
  for (const args of [[], ['--destination', 'relative'], ['--dest', '/absolute'], ['/absolute']])
    test(`rejects ${JSON.stringify(args)} before any download`, () => {
      const result = run(['node', script('install-bun.mjs'), ...args], {
        ...process.env,
        GITHUB_PATH: '',
      })
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(
        'Error: Usage: node scripts/install-bun.mjs --destination <absolute directory>'
      )
    })
})

describe('scripts/package-native.ts argument contract', () => {
  const usage =
    'Usage: bun scripts/package-native.ts --outdir /new/absolute/package-set-directory\n'

  test('requires an absolute --outdir before snapshotting the source tree', () => {
    for (const args of [[], ['--outdir', 'relative/package-set'], ['--outdir', '']]) {
      const result = bun('package-native.ts', ...args)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(usage)
    }
  })

  test('rejects unknown options and positionals', () => {
    for (const args of [['--bogus'], ['/absolute/positional']]) {
      const result = bun('package-native.ts', ...args)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).not.toBe('')
      expect(result.stderr).not.toBe(usage)
    }
  })
})

describe('scripts/quality/standalone-lock-control.ts argument contract', () => {
  const usage =
    'Error: Usage: standalone-lock-control.ts --input ABSOLUTE_RETAINED_COHORT --prior ABSOLUTE_C16_FAILED_CONTROL --outdir ABSOLUTE_NEW_DIRECTORY\n'

  test('requires three absolute directories before platform, compiler or git checks', () => {
    for (const args of [
      [],
      ['--input', '/input', '--prior', '/prior'],
      ['--input', '/input', '--prior', 'prior', '--outdir', '/outdir'],
      ['--input', 'input', '--prior', '/prior', '--outdir', '/outdir'],
      ['--input', '/input', '--prior', '/prior', '--outdir', 'outdir'],
    ]) {
      const result = bun('quality/standalone-lock-control.ts', ...args)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(usage)
    }
  })

  test('rejects unknown options', () => {
    const result = bun('quality/standalone-lock-control.ts', '--bogus', 'value')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Unknown option '--bogus'")
  })
})

describe('scripts/quality/standalone-package-inspect.ts preconditions', () => {
  const usage = 'Usage: standalone-package-inspect.ts ABSOLUTE_PROJECT lock|imports'

  test('requires an absolute project and a lock or imports mode', () => {
    for (const args of [[], ['relative', 'lock'], ['/absolute'], ['/absolute', 'install']]) {
      const result = bun('quality/standalone-package-inspect.ts', ...args)
      expect(result.code).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(usage)
    }
  })

  test.skipIf(process.platform === 'win32')(
    'refuses an installed CLI that resolves outside the consumer project',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'bun-native-inspect-'))
      temporary.push(directory)
      const project = join(directory, 'project')
      const outside = join(directory, 'outside-cli')
      mkdirSync(join(project, 'node_modules/@bun-native/cli'), {
        recursive: true,
      })
      mkdirSync(outside)
      symlinkSync(outside, join(project, 'node_modules/@bun-native/cli/src'), 'dir')
      for (const mode of ['lock', 'imports']) {
        const result = bun('quality/standalone-package-inspect.ts', project, mode)
        expect(result.code).not.toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('Inspector CLI resolves outside the consumer')
      }
    }
  )

  test('fails without output when the consumer has no installed CLI', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bun-native-inspect-'))
    temporary.push(directory)
    const result = bun('quality/standalone-package-inspect.ts', directory, 'lock')
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('ENOENT')
  })
})
