import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

function fixture(
  command: 'check' | 'fmt' | 'test' | 'build',
  exercise: (cwd: string) => void
): void {
  const cwd = mkdtempSync(join(tmpdir(), 'bun-native-command-'))
  try {
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ private: true, scripts: { [command]: 'bun sentinel.cjs' } })
    )
    writeFileSync(
      join(cwd, 'sentinel.cjs'),
      "require('node:fs').writeFileSync('script-ran', 'package script\\n')\n"
    )
    exercise(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function run(cwd: string, args: string[]) {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env['PATH'] ?? ''}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  })
  expect(result.signalCode ?? null).toBeNull()
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
}

function resetScriptMarker(cwd: string): void {
  expect(readFileSync(join(cwd, 'script-ran'), 'utf8')).toBe('package script\n')
  rmSync(join(cwd, 'script-ran'))
}

describe('pinned Bun built-ins cannot be replaced by same-named package scripts', () => {
  test('build --no-script selects production dependencies and rejects malformed source', () => {
    fixture('build', (cwd) => {
      const source = join(cwd, 'main.ts')
      const output = join(cwd, 'application.js')
      const dependency = join(cwd, 'node_modules', 'framework')
      mkdirSync(dependency, { recursive: true })
      writeFileSync(
        join(dependency, 'package.json'),
        JSON.stringify({ name: 'framework', main: 'index.cjs' })
      )
      writeFileSync(
        join(dependency, 'index.cjs'),
        "exports.mode = process.env.NODE_ENV === 'production' ? 'production' : 'development'\n"
      )
      writeFileSync(
        source,
        "import { mode } from 'framework'; const value: number = 42; console.log(value, mode)\n"
      )
      expect(run(cwd, ['run', 'build']).exitCode).toBe(0)
      resetScriptMarker(cwd)
      const command = [
        'build',
        '--no-script',
        '--production',
        '--define',
        'process.env.NODE_ENV="production"',
        '--target=bun',
        '--format=esm',
        '--sourcemap=external',
        source,
        '--outdir',
        cwd,
        '--entry-naming=application.js',
      ]
      const built = run(cwd, command)
      expect(built.exitCode).toBe(0)
      expect(existsSync(output)).toBe(true)
      expect(existsSync(output + '.map')).toBe(true)
      expect(run(cwd, [output])).toEqual({ exitCode: 0, output: '42 production\n' })
      expect(existsSync(join(cwd, 'script-ran'))).toBe(false)
      writeFileSync(source, 'export const malformed = <\n')
      const rejected = run(cwd, command)
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.output).toContain('main.ts')
      expect(existsSync(join(cwd, 'script-ran'))).toBe(false)
    })
  }, 15_000)

  test('check --no-script rejects wrong types and accepts a corrected source', () => {
    fixture('check', (cwd) => {
      writeFileSync(
        join(cwd, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, types: [], lib: ['ESNext'] },
          include: ['main.ts'],
        })
      )
      writeFileSync(join(cwd, 'main.ts'), 'export const invalidType: number = "wrong"\n')
      expect(run(cwd, ['check']).exitCode).toBe(0)
      resetScriptMarker(cwd)

      const rejected = run(cwd, ['check', '--no-script', '--no-pretty'])
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.output).toContain('TS2322')
      expect(rejected.output).toContain('main.ts')
      expect(existsSync(join(cwd, 'script-ran'))).toBe(false)

      writeFileSync(join(cwd, 'main.ts'), 'export const correctType: number = 42\n')
      expect(run(cwd, ['check', '--no-script', '--no-pretty']).exitCode).toBe(0)
      expect(existsSync(join(cwd, 'script-ran'))).toBe(false)
    })
  }, 15_000)

  test('fmt --no-script --check detects formatting without rewriting the file', () => {
    fixture('fmt', (cwd) => {
      const source = 'export const value={nested:[1,2,3]};\n'
      writeFileSync(join(cwd, 'main.ts'), source)
      expect(run(cwd, ['fmt', '--check', 'main.ts']).exitCode).toBe(0)
      resetScriptMarker(cwd)

      const rejected = run(cwd, ['fmt', '--no-script', '--check', 'main.ts'])
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.output).toContain('main.ts')
      expect(readFileSync(join(cwd, 'main.ts'), 'utf8')).toBe(source)
      expect(existsSync(join(cwd, 'script-ran'))).toBe(false)

      expect(run(cwd, ['fmt', '--no-script', 'main.ts']).exitCode).toBe(0)
      expect(readFileSync(join(cwd, 'main.ts'), 'utf8')).not.toBe(source)
      expect(run(cwd, ['fmt', '--no-script', '--check', 'main.ts']).exitCode).toBe(0)
      expect(existsSync(join(cwd, 'script-ran'))).toBe(false)
    })
  }, 15_000)

  test('test executes passing and failing tests independently of the test script', () => {
    fixture('test', (cwd) => {
      const source =
        'import { expect, test } from "bun:test"\n' +
        'test("intentional native-tooling fixture", () => expect(1).toBe(2))\n'
      writeFileSync(join(cwd, 'case.test.ts'), source)
      expect(run(cwd, ['run', 'test']).exitCode).toBe(0)
      resetScriptMarker(cwd)

      const rejected = run(cwd, ['test', '--timeout', '1000', 'case.test.ts'])
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.output).toContain('intentional native-tooling fixture')
      expect(rejected.output).toContain('1 fail')
      expect(existsSync(join(cwd, 'script-ran'))).toBe(false)

      writeFileSync(join(cwd, 'case.test.ts'), source.replace('toBe(2)', 'toBe(1)'))
      const passed = run(cwd, ['test', '--timeout', '1000', 'case.test.ts'])
      expect(passed.exitCode).toBe(0)
      expect(passed.output).toContain('1 pass')
      expect(existsSync(join(cwd, 'script-ran'))).toBe(false)
    })
  }, 15_000)
})
