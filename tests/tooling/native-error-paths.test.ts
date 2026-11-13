import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as artifact from '../../scripts/native/artifact.ts'
import * as compiler from '../../scripts/native/compile.ts'
import * as inspector from '../../scripts/native/inspect.ts'
import * as runtimeInspector from '../../scripts/native/inspect-runtime.ts'
import * as standalone from '../../scripts/native/standalone.ts'
import { buildProject } from '../../scripts/native/build.ts'
import { createProject, readProject } from '../../scripts/native/project.ts'
import { DevSession } from '../../scripts/native/session.ts'
import { watchProject } from '../../scripts/native/watch.ts'
import { buildSolid } from '../../scripts/solid-build.ts'
import { packageFixture } from './package-fixture.ts'

const repository = resolve(import.meta.dir, '../..')
// The applications below never contact a host; the variable is only forwarded.
const host = process.execPath
let directory: string

beforeAll(() => {
  mkdirSync(join(repository, '.bun-native'), { recursive: true })
  directory = mkdtempSync(join(repository, '.bun-native/error-paths-test-'))
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function rejected(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('Expected operation to reject')
}

async function application(name: string, source: string) {
  const path = await createProject(repository, join(directory, name), 'solid', 'typescript')
  const project = await readProject(repository, path)
  writeFileSync(project.entry, source)
  return { path, project }
}

describe('AOT compiler wrapper (controlled compiler and inspector results)', () => {
  test('reports a failed compiler process with its diagnostics and keeps the logs', () => {
    const output = join(directory, 'failed-compile', 'application')
    mkdirSync(join(directory, 'failed-compile'))
    expect(() =>
      compiler.compileApplication(join(directory, 'missing-entry.ts'), output, repository)
    ).toThrow('compile-aot failed')
    expect(existsSync(join(directory, 'failed-compile', 'compile-aot.stderr.log'))).toBe(true)
    expect(existsSync(output)).toBe(false)
  })

  test('rejects outputs without a compiled program or with the JIT compiler retained', () => {
    mkdirSync(join(directory, 'inspected-compile'))
    const output = join(directory, 'inspected-compile', 'application')
    // The controlled compiler "writes" inert bytes; the inspectors below decide.
    writeFileSync(output, 'inert executable bytes')
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(
      () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) as never
    )
    const executable = spyOn(inspector, 'inspectBunExecutable')
    const runtime = spyOn(runtimeInspector, 'inspectBunRuntime')
    try {
      executable.mockImplementation(() => ({ hasCompiledProgram: false }) as never)
      expect(() => compiler.compileApplication('entry.ts', output, repository)).toThrow(
        'no compiled-program record'
      )
      executable.mockImplementation(() => ({ hasCompiledProgram: true }) as never)
      for (const features of [
        { jit: 'present', jitRemovedRanges: { count: 1 } },
        { jit: 'absent', jitRemovedRanges: { count: 0 } },
      ]) {
        runtime.mockImplementation(() => features as never)
        expect(() => compiler.compileApplication('entry.ts', output, repository)).toThrow(
          'does not record removal of the JIT compiler'
        )
      }
    } finally {
      spawn.mockRestore()
      executable.mockRestore()
      runtime.mockRestore()
    }
  })
})

describe('application packaging input stability (controlled digests)', () => {
  test.each([
    ['packaged host', ['host', 'module', 'copied'], 'Prebuilt host changed while packaging'],
    ['source host', ['host', 'module', 'host', 'changed'], 'Prebuilt host changed while packaging'],
    [
      'development module',
      ['host', 'module', 'host', 'host', 'changed'],
      'Application module changed during AOT compilation',
    ],
  ])('rejects a %s that changes during compilation', async (name, sequence, message) => {
    const { project } = await application(`changed-${name.replace(' ', '-')}`, 'export {}\n')
    const prebuilt = join(directory, `host-${name.replace(' ', '-')}`)
    writeFileSync(prebuilt, 'inert host bytes')
    const destination = join(directory, `dist-${name.replace(' ', '-')}`)
    let call = 0
    const digest = spyOn(artifact, 'fileDigest').mockImplementation(async () => ({
      bytes: 1,
      sha256: sequence[call++] ?? 'unexpected',
    }))
    const compile = spyOn(compiler, 'compileApplication').mockImplementation(() => ({}) as never)
    try {
      expect(
        (await rejected(buildProject(project, prebuilt, destination, 'dev'))).message
      ).toStartWith(message)
      expect(compile).toHaveBeenCalledTimes(1)
      expect(existsSync(join(destination, 'manifest.json'))).toBe(false)
    } finally {
      digest.mockRestore()
      compile.mockRestore()
    }
  })
})

describe('Solid build entry validation', () => {
  test('rejects directories and non-script entries before bundling', async () => {
    const text = join(directory, 'entry.txt')
    writeFileSync(text, 'not a module')
    for (const entry of [directory, text])
      expect((await rejected(buildSolid(entry, join(directory, 'never-built')))).message).toBe(
        'Solid entry must be a TypeScript/JavaScript source file'
      )
    expect(existsSync(join(directory, 'never-built'))).toBe(false)
  })
})

describe('project creation parents and cleanup', () => {
  test('creates missing parent directories and rejects a parent below a regular file', async () => {
    const nested = join(directory, 'missing/parents/app')
    expect(await createProject(repository, nested, 'react', 'javascript')).toBe(nested)
    expect((await readProject(repository, nested)).framework).toBe('react')
    const file = join(directory, 'parent-file')
    writeFileSync(file, 'regular file')
    const error = await rejected(
      createProject(repository, join(file, 'child/app'), 'solid', 'typescript')
    )
    expect((error as Error & { code?: string }).code).toBe('ENOTDIR')
  })

  test('removes a partially created standalone project when copying its package set fails', async () => {
    await packageFixture(async ({ directory: root, manifest }) => {
      const destination = join(root, 'partial')
      const failure = new Error('controlled copy failure')
      const copy = spyOn(standalone, 'copyPackageSet').mockImplementation(async () => {
        throw failure
      })
      try {
        expect(
          await rejected(createProject(repository, destination, 'solid', 'typescript', manifest))
        ).toBe(failure)
        expect(existsSync(destination)).toBe(false)
      } finally {
        copy.mockRestore()
      }
    })
  })
})

describe('development session failure paths (real Bun child processes; no host)', () => {
  test('rejects timeouts outside the supported bound', () => {
    for (const timeout of [0, 60_001, 1.5, Number.NaN])
      expect(() => new DevSession(repository, directory, host, timeout)).toThrow(
        'Dev session timeout must be between 1 and 60000 milliseconds'
      )
  })

  test('an application that exits before readiness stops the session with both failures', async () => {
    const { path } = await application('early-exit', 'process.exit(7)\n')
    const session = new DevSession(repository, path, host, 2_000)
    const error = await rejected(session.reload())
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toBe('Application startup failed and the session was stopped')
    const [startup, cleanup] = (error as AggregateError).errors as Error[]
    expect(startup!.message).toContain('Application exited before readiness (7)')
    expect(cleanup!.message).toContain('did not report clean teardown (exit 7)')
    expect(await session.exited).toBe(1)
    expect((await rejected(session.reload())).message).toBe('Development session is closed')
    expect(await session.close()).toBeUndefined()
    expect(existsSync(session.temporaryDirectory)).toBe(false)
  })

  test('a readiness timeout with a clean acknowledged stop reports only the timeout', async () => {
    const { path } = await application(
      'never-ready',
      `const zero = { windows: 0, nodes: 0, callbacks: 0, queuedTransactions: 0, queuedCallbacks: 0, activeCallbacks: 0, serviceRequests: 0 }
process.send?.('not a record')
process.send?.(['bun-native:ready'])
process.on('message', () => {
  process.send?.({ type: 'bun-native:stopped', application: zero, nodes: 0 })
  process.disconnect?.()
})
`
    )
    const session = new DevSession(repository, path, host, 300)
    const error = await rejected(session.reload())
    expect(error).not.toBeInstanceOf(AggregateError)
    expect(error.message).toContain('Application readiness timed out')
    expect(await session.exited).toBe(1)
    expect(await session.close()).toBeUndefined()
    expect(existsSync(session.temporaryDirectory)).toBe(false)
  })

  test('a disconnected application that ignores shutdown is killed after the bound', async () => {
    const { path } = await application(
      'disconnected',
      'process.disconnect?.()\nsetInterval(() => {}, 1_000)\n'
    )
    const session = new DevSession(repository, path, host, 200)
    const error = await rejected(session.reload())
    expect(error).toBeInstanceOf(AggregateError)
    const [startup, cleanup] = (error as AggregateError).errors as Error[]
    expect(startup!.message).toContain('Application readiness timed out')
    expect(cleanup!.message).toBe('Application did not acknowledge shutdown in time')
    expect(await session.close()).toBeUndefined()
    expect(existsSync(session.temporaryDirectory)).toBe(false)
  })

  test('watch rejects an application that exits after readiness without clean teardown', async () => {
    const { path } = await application(
      'watch-exit',
      "process.send?.({ type: 'bun-native:ready' })\nsetTimeout(() => process.exit(23), 50)\n"
    )
    const log = console.log
    const output: string[] = []
    const signals = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name))
    console.log = (...values: unknown[]) => {
      output.push(values.map(String).join(' '))
    }
    try {
      const error = await rejected(watchProject(repository, path, host))
      expect(error.message).toMatch(/exit 23|without clean teardown/)
    } finally {
      console.log = log
    }
    expect(output.some((line) => line.startsWith('Watching project source.'))).toBe(true)
    expect(['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name))).toEqual(signals)
  })
})
