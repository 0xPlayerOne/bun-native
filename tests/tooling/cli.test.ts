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
import { buildProject, bundleProject } from '../../scripts/native/build.ts'
import { prebuiltHost } from '../../scripts/native/host.ts'
import { createProject, readProject } from '../../scripts/native/project.ts'
import { protocolPeer } from './headless-peer.ts'
import { hostHeader } from './host-fixture.ts'

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
          expect(await createProject(repository, projectPath, framework, language)).toBe(
            projectPath
          )
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
      // The existing protocol peer, compiled once per test process, so the
      // unmodified host option points to one executable, as for a GPUI host.
      const peer = protocolPeer()
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
              `const initialSignals = ['SIGINT', 'SIGTERM', 'message'].map((name) => process.listenerCount(name))\n` +
                original.replace(
                  'await view.ready',
                  `await view.ready\n  ${stop === 'window-close' ? 'await window.close()' : `process.emit('${stop}')`}`
                ) +
                `\nconsole.log('template-cleanup:' + JSON.stringify({ core: application.diagnostics, nodes: view?.diagnostics.nodes, signals: ['SIGINT', 'SIGTERM', 'message'].map((name, index) => process.listenerCount(name) - initialSignals[index]) }))\n`
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
              signals: [0, 0, 0],
            })
            expect(readdirSync(join(path, '.bun-native'))).toEqual([])
          }
        }
      }
    })
  }, 130_000)

  test('generated templates terminate and clean up after a post-readiness renderer failure', async () => {
    await fixture(async (directory) => {
      const peer = protocolPeer()
      for (const framework of ['solid', 'react']) {
        for (const language of ['typescript', 'javascript']) {
          const path = join(directory, framework + '-' + language)
          success([cli, 'create', path, '--framework', framework, '--language', language])
          const project = await readProject(repository, path)
          const original = readFileSync(project.entry, 'utf8')
          const state = `const [clicks, setClicks] = ${framework === 'solid' ? 'createSignal' : 'useState'}(0)`
          const deadline =
            language === 'typescript'
              ? 'let failureDeadline: ReturnType<typeof setTimeout> | undefined'
              : 'let failureDeadline'
          // Trigger a real adapter/native-style rejection after the first mounted
          // acknowledgement, without closing the still-healthy native window.
          // The deadline releases the unfixed fixture cleanly but is never a pass.
          writeFileSync(
            project.entry,
            `let failAfterReady = () => {}\n${deadline}\nconst initialSignals = ['SIGINT', 'SIGTERM', 'message'].map((name) => process.listenerCount(name))\n` +
              original
                .replace(state, state + '\n  failAfterReady = () => setClicks(1)')
                .replace(
                  'width: 160, height: 44',
                  `width: ${framework === 'solid' ? 'clicks()' : 'clicks'} ? -1 : 160, height: 44`
                )
                .replace(
                  'await view.ready',
                  `await view.ready
  void view.closed.catch((error) => {
    console.log('post-ready-root-failure:' + JSON.stringify({ message: String(error), windows: application.diagnostics.windows, nodes: view?.diagnostics.nodes }))
    failureDeadline = setTimeout(() => { console.log('renderer-failure-deadline'); stop() }, 1000)
  })
  queueMicrotask(failAfterReady)`
                )
                .replace(
                  "process.off('SIGINT', stop)",
                  "clearTimeout(failureDeadline)\n  process.off('SIGINT', stop)"
                )
                .replace(
                  'await application.closed',
                  `await application.closed
    console.log('post-failure-cleanup:' + JSON.stringify({ core: application.diagnostics, nodes: view?.diagnostics.nodes, signals: ['SIGINT', 'SIGTERM', 'message'].map((name, index) => process.listenerCount(name) - initialSignals[index]) }))`
                )
          )
          const result = run([cli, 'dev', path, '--host', peer])
          expect(result.signal).toBeNull()
          expect(result.code).toBe(1)
          expect(result.output).not.toContain('renderer-failure-deadline')
          const failure = result.output
            .split('\n')
            .find((line) => line.startsWith('post-ready-root-failure:'))
          const cleanup = result.output
            .split('\n')
            .find((line) => line.startsWith('post-failure-cleanup:'))
          if (!failure || !cleanup) throw new Error(`${framework}/${language}: ${result.output}`)
          expect(JSON.parse(failure.slice('post-ready-root-failure:'.length))).toMatchObject({
            windows: 1,
            nodes: 0,
          })
          expect(JSON.parse(cleanup.slice('post-failure-cleanup:'.length))).toEqual({
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
            signals: [0, 0, 0],
          })
          expect(readdirSync(join(path, '.bun-native'))).toEqual([])
        }
      }
    })
  }, 130_000)

  test('rejects existing/outside destinations and invalid project or command options without overwriting', async () => {
    await fixture(async (directory) => {
      const path = join(directory, 'app')
      success([cli, 'create', path])
      const original = readFileSync(join(path, 'main.tsx'), 'utf8')
      await expect(createProject(repository, path, 'solid', 'typescript')).rejects.toThrow()
      expect(readFileSync(join(path, 'main.tsx'), 'utf8')).toBe(original)
      await expect(
        createProject(repository, join(tmpdir(), 'outside-checkout-project'), 'solid', 'typescript')
      ).rejects.toThrow('inside this Bun Native checkout')
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
      await expect(readProject(repository, path)).rejects.toThrow('bun-native.json requires')
      writeFileSync(join(directory, 'outside.ts'), 'console.log(42)\n')
      writeFileSync(
        join(path, 'bun-native.json'),
        JSON.stringify({ schemaVersion: 1, framework: 'solid', entry: '../outside.ts' })
      )
      await expect(readProject(repository, path)).rejects.toThrow('inside the project')
      writeFileSync(join(path, 'bun-native.json'), 'null\n')
      await expect(readProject(repository, path)).rejects.toThrow('Invalid bun-native.json')
      if (process.platform !== 'win32') {
        symlinkSync(tmpdir(), join(directory, 'outside-link'), 'dir')
        await expect(
          createProject(
            repository,
            join(directory, 'outside-link', 'new-project'),
            'solid',
            'typescript'
          )
        ).rejects.toThrow('outside this Bun Native checkout')
      }
    })
  })

  test('requires an executable, current-platform host and an explicit build profile', async () => {
    await fixture(async (directory) => {
      const path = join(directory, 'app')
      success([cli, 'create', path])
      expect(await prebuiltHost(process.execPath)).toBe(process.execPath)
      for (const host of [undefined, 'relative-host'])
        await expect(prebuiltHost(host)).rejects.toThrow('--host must be an absolute path')
      // Keep command parsing/error propagation coverage beside in-process API checks.
      const missingOption = run([cli, 'dev', path])
      expect(missingOption.code).not.toBe(0)
      expect(missingOption.output).toContain('never runs Cargo')
      await expect(prebuiltHost(join(directory, 'missing-host'))).rejects.toThrow()
      await expect(prebuiltHost(directory)).rejects.toThrow('must be a file')
      const host = join(directory, 'wrong-host')
      writeFileSync(host, Buffer.alloc(128))
      chmodSync(host, 0o755)
      await expect(prebuiltHost(host)).rejects.toThrow('executable')
      if (process.platform !== 'win32') {
        chmodSync(host, 0o644)
        await expect(prebuiltHost(host)).rejects.toThrow()
      }
      expect(run([cli, 'build', path, '--host', process.execPath]).output).toContain(
        'requires --host-profile'
      )
      expect(existsSync(join(path, 'dist'))).toBe(false)
    })
  })

  test('rejects recognized foreign-platform and wrong-CPU hosts before dev or build', async () => {
    await fixture(async (directory) => {
      const path = join(directory, 'app')
      await createProject(repository, path, 'solid', 'typescript')
      writeFileSync(join(path, 'main.tsx'), "console.log('unexpected application execution')\n")
      const message = `Prebuilt host must be a ${process.platform}/${process.arch} executable`
      for (const platform of ['linux', 'darwin', 'win32'] as const) {
        for (const architecture of ['x64', 'arm64'] as const) {
          if (platform === process.platform && architecture === process.arch) continue
          const host = join(directory, `${platform}-${architecture}.host`)
          writeFileSync(host, hostHeader(platform, architecture))
          chmodSync(host, 0o755)
          await expect(prebuiltHost(host)).rejects.toThrow(message)
          for (const command of ['dev', 'build']) {
            const args = [cli, command, path, '--host', host]
            if (command === 'build') args.push('--host-profile', 'release')
            const rejected = run(args)
            expect(rejected.signal).toBeNull()
            expect(rejected.code).not.toBe(0)
            expect(rejected.output).toContain(message)
            expect(rejected.output).not.toContain('unexpected application execution')
          }
        }
      }
      expect(existsSync(join(path, '.bun-native'))).toBe(false)
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
      const outdir = join(path, 'dist')
      const project = await readProject(repository, path)
      const host = await prebuiltHost(process.execPath)
      const manifest = await buildProject(project, host, outdir, 'release')
      expect(JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8'))).toEqual(manifest)
      expect(manifest.application.inspection.hasCompiledProgram).toBe(true)
      expect(manifest.application.runtimeFeatures.jit).not.toBe('present')
      expect(manifest.application.runtimeFeatures.jitRemovedRanges.count).toBeGreaterThan(0)
      expect(manifest.host.sha256).toBe(
        createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
      )
      expect(manifest.verification.nativeRendering).toBe('not-run')
      await expect(buildProject(project, host, outdir, 'release')).rejects.toThrow(
        'Output directory must be empty'
      )
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
