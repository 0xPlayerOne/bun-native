import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bundleProject } from '../../scripts/native/build.ts'
import { readProject } from '../../scripts/native/project.ts'
import { compileApplication } from '../../experiments/aot-gpui/compile.ts'

const repository = resolve(import.meta.dir, '../..')
const cli = join(repository, 'scripts/native.ts')

async function fixture(exercise: (directory: string) => Promise<void> | void): Promise<void> {
  const cache = join(repository, '.bun-native')
  mkdirSync(cache, { recursive: true })
  const directory = mkdtempSync(join(cache, 'cli-test-'))
  try {
    await exercise(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function run(args: string[], cwd = repository, timeout = 15_000) {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout,
    maxBuffer: 1024 * 1024,
  })
  return {
    code: result.exitCode,
    signal: result.signalCode ?? null,
    output: result.stdout.toString() + result.stderr.toString(),
  }
}

function success(args: string[], cwd?: string) {
  const result = run(args, cwd)
  expect(result.signal).toBeNull()
  if (result.code !== 0) throw new Error(result.output)
  return result.output
}

describe('checkout application CLI (real bundler and compiler; no native rendering)', () => {
  for (const framework of ['solid', 'react'] as const) {
    for (const language of ['typescript', 'javascript'] as const) {
      test(`creates, typechecks and bundles ${framework} ${language}`, async () => {
        await fixture(async (directory) => {
          const projectPath = join(directory, 'new app')
          success([cli, 'create', projectPath, '--framework', framework, '--language', language])
          const project = await readProject(repository, projectPath)
          expect(project.framework).toBe(framework)
          expect(project.entry.endsWith(language === 'typescript' ? '.tsx' : '.jsx')).toBe(true)
          expect(existsSync(join(projectPath, 'node_modules'))).toBe(false)
          success(['run', 'check'], projectPath)
          const module = await bundleProject(project, join(directory, 'module'))
          expect(existsSync(module)).toBe(true)
          const map: { sources: string[] } = JSON.parse(readFileSync(module + '.map', 'utf8'))
          expect(
            map.sources.some((path) =>
              path.replaceAll('\\', '/').includes(`/packages/${framework}/src/`)
            )
          ).toBe(true)
          expect(map.sources.some((path) => path.includes('react-dom'))).toBe(false)
          expect(readFileSync(join(projectPath, 'README.md'), 'utf8')).toContain(
            'hot reload is not implemented'
          )
        })
      }, 20_000)
    }
  }

  test('dev uses the supplied host, picks up edits on restart and cleans temporary bundles', async () => {
    await fixture(async (directory) => {
      const path = join(directory, 'app')
      success([cli, 'create', path])
      const entry = join(path, 'main.tsx')
      writeFileSync(entry, "console.log('first:' + process.env['BUN_NATIVE_HOST'])\n")
      expect(success(['run', 'dev', '--host', process.execPath], path)).toContain(
        'first:' + process.execPath
      )
      writeFileSync(entry, "console.log('second:' + process.env['BUN_NATIVE_HOST'])\n")
      expect(success([cli, 'dev', path, '--host', process.execPath])).toContain(
        'second:' + process.execPath
      )
      expect(readdirSync(join(path, '.bun-native'))).toEqual([])
      writeFileSync(entry, 'const broken = <\n')
      const rejected = run([cli, 'dev', path, '--host', process.execPath])
      expect(rejected.code).not.toBe(0)
      expect(rejected.output).toContain('main.tsx')
      expect(rejected.output).not.toContain('second:')
      expect(readdirSync(join(path, '.bun-native'))).toEqual([])
    })
  }, 20_000)

  test('generated templates dispose roots, application handles and signal listeners over real headless IPC', async () => {
    await fixture(async (directory) => {
      const peer = join(directory, process.platform === 'win32' ? 'peer.exe' : 'peer')
      // Compile the existing protocol peer so the unmodified host option points
      // to one executable, exactly as it does for a supplied GPUI host.
      compileApplication(join(repository, 'tests/core/protocol-peer.ts'), peer, repository)
      for (const framework of ['solid', 'react']) {
        for (const language of ['typescript', 'javascript']) {
          const path = join(directory, framework + '-' + language)
          success([cli, 'create', path, '--framework', framework, '--language', language])
          const project = await readProject(repository, path)
          const original = readFileSync(project.entry, 'utf8')
          for (const stop of ['window-close', 'SIGINT', 'SIGTERM']) {
            // Only request closure after the real mounted acknowledgement and
            // inspect public diagnostics after the generated cleanup finishes.
            // process.emit tests the registered signal path, not OS delivery.
            writeFileSync(
              project.entry,
              `const initialSignals = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name))\n` +
                original.replace(
                  'await view.ready',
                  `await view.ready\n  ${stop === 'window-close' ? 'await window.close()' : `process.emit('${stop}')`}`
                ) +
                `\nconsole.log('template-cleanup:' + JSON.stringify({ core: application.diagnostics, nodes: view?.diagnostics.nodes, signals: ['SIGINT', 'SIGTERM'].map((name, index) => process.listenerCount(name) - initialSignals[index]) }))\n`
            )
            const result = run([cli, 'dev', path, '--host', peer])
            if (result.code !== 0 || result.signal !== null)
              throw new Error(`${framework}/${language}/${stop}: ${result.output}`)
            const report = result.output
              .split('\n')
              .find((line) => line.startsWith('template-cleanup:'))
            if (!report)
              throw new Error(`Missing cleanup report for ${framework}/${language}/${stop}`)
            expect(JSON.parse(report.slice('template-cleanup:'.length))).toEqual({
              core: {
                windows: 0,
                nodes: 0,
                callbacks: 0,
                queuedTransactions: 0,
                queuedCallbacks: 0,
                activeCallbacks: 0,
                serviceRequests: 0,
              },
              nodes: 0,
              signals: [0, 0],
            })
            expect(readdirSync(join(path, '.bun-native'))).toEqual([])
          }
        }
      }
    })
  }, 130_000)

  test('rejects existing/outside destinations and invalid project or command options without overwriting', async () => {
    await fixture(async (directory) => {
      const path = join(directory, 'app')
      success([cli, 'create', path])
      const original = readFileSync(join(path, 'main.tsx'), 'utf8')
      expect(run([cli, 'create', path]).code).not.toBe(0)
      expect(readFileSync(join(path, 'main.tsx'), 'utf8')).toBe(original)
      expect(run([cli, 'create', join(tmpdir(), 'outside-checkout-project')]).output).toContain(
        'inside this Bun Native checkout'
      )
      expect(
        run([cli, 'create', join(directory, 'invalid'), '--framework', 'vue']).output
      ).toContain('--framework must be')
      expect(
        run([cli, 'create', join(directory, 'invalid'), '--language', 'coffee']).output
      ).toContain('--language must be')
      expect(existsSync(join(directory, 'invalid'))).toBe(false)
      expect(run([cli, 'build', path, '--target', 'other-os']).code).not.toBe(0)
      writeFileSync(
        join(path, 'bun-native.json'),
        JSON.stringify({ schemaVersion: 1, framework: 'solid', entry: 'main.tsx', typo: true })
      )
      expect(run([cli, 'dev', path, '--host', process.execPath]).output).toContain(
        'bun-native.json requires'
      )
      writeFileSync(join(directory, 'outside.ts'), 'console.log(42)\n')
      writeFileSync(
        join(path, 'bun-native.json'),
        JSON.stringify({ schemaVersion: 1, framework: 'solid', entry: '../outside.ts' })
      )
      expect(run([cli, 'dev', path, '--host', process.execPath]).output).toContain(
        'inside the project'
      )
      if (process.platform !== 'win32') {
        symlinkSync(tmpdir(), join(directory, 'outside-link'), 'dir')
        expect(
          run([cli, 'create', join(directory, 'outside-link', 'new-project')]).output
        ).toContain('outside this Bun Native checkout')
      }
    })
  })

  test('requires an executable, current-platform host and an explicit build profile', async () => {
    await fixture(async (directory) => {
      const path = join(directory, 'app')
      success([cli, 'create', path])
      for (const args of [[], ['--host', 'relative-host']]) {
        const rejected = run([cli, 'dev', path, ...args])
        expect(rejected.code).not.toBe(0)
        expect(rejected.output).toContain('--host must be an absolute path')
        expect(rejected.output).toContain('never runs Cargo')
      }
      expect(run([cli, 'dev', path, '--host', join(directory, 'missing-host')]).code).not.toBe(0)
      expect(run([cli, 'dev', path, '--host', directory]).output).toContain('must be a file')
      const host = join(directory, 'wrong-host')
      writeFileSync(host, Buffer.alloc(128))
      chmodSync(host, 0o755)
      expect(run([cli, 'dev', path, '--host', host]).output).toContain('executable')
      if (process.platform !== 'win32') {
        chmodSync(host, 0o644)
        expect(run([cli, 'dev', path, '--host', host]).code).not.toBe(0)
      }
      expect(run([cli, 'build', path, '--host', process.execPath]).output).toContain(
        'requires --host-profile'
      )
      expect(existsSync(join(path, 'dist'))).toBe(false)
    })
  })

  test('packages inspected AOT plus hashed supplied executable and survives relocation', async () => {
    await fixture(async (directory) => {
      const path = join(directory, 'app')
      success([cli, 'create', path, '--framework', 'react'])
      // This deliberately uses a headless program and Bun as the supplied executable.
      // It proves packaging and launch resolution, not the GPUI handshake/rendering.
      writeFileSync(
        join(path, 'main.tsx'),
        "console.log(JSON.stringify({ answer: 42, host: process.env['BUN_NATIVE_HOST'] }))\n"
      )
      const result = run(
        [cli, 'build', path, '--host', process.execPath, '--host-profile', 'release'],
        repository,
        120_000
      )
      expect(result.signal).toBeNull()
      if (result.code !== 0) throw new Error(result.output)
      const outdir = join(path, 'dist')
      const manifest = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8'))
      expect(manifest.application.inspection.hasCompiledProgram).toBe(true)
      expect(manifest.application.runtimeFeatures.jit).not.toBe('present')
      expect(manifest.application.runtimeFeatures.jitRemovedRanges.count).toBeGreaterThan(0)
      expect(manifest.host.sha256).toBe(
        createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
      )
      expect(manifest.verification.nativeRendering).toBe('not-run')
      expect(
        run([cli, 'build', path, '--host', process.execPath, '--host-profile', 'release']).output
      ).toContain('Output directory must be empty')
      const moved = join(directory, 'relocated')
      renameSync(outdir, moved)
      const { BUN_NATIVE_HOST: _host, ...env } = process.env
      const launched = Bun.spawnSync([join(moved, manifest.application.file)], {
        cwd: tmpdir(),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      })
      expect(launched.exitCode).toBe(0)
      expect(JSON.parse(launched.stdout.toString())).toEqual({
        answer: 42,
        host: join(moved, manifest.host.file),
      })
    })
  }, 130_000)
})
