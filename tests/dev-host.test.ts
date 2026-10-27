import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  DevelopmentError,
  developmentHostKey,
  prepareDevelopmentHost,
  type DevelopmentHostIdentity,
} from '../packages/cli/src/dev-cache.ts'
import {
  DevelopmentSession,
  type DevelopmentBundle,
  type DevelopmentDiagnostic,
  type DevelopmentSessionOptions,
} from '../packages/cli/src/dev-host.ts'

const sha = (source: string): string => createHash('sha256').update(source).digest('hex')
async function temporary(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bunly-dev-'))
}
async function identity(root: string): Promise<DevelopmentHostIdentity> {
  await writeFile(join(root, 'native'), 'native-host-v1')
  return {
    appId: 'test.app',
    nativeAbi: '1',
    engineVersion: 'cef:156.0.7',
    target: `${process.platform}-${process.arch}`,
    bunVersion: Bun.version,
    configuration: '{"origin":"app://test","protocol":1}',
    inputs: [{ name: 'native-host', path: join(root, 'native'), sha256: sha('native-host-v1') }],
  }
}
test('prepared host reuses verified bytes; source-only edits do not assemble native artifacts', async () => {
  const root = await temporary()
  try {
    const spec = await identity(root)
    let assemblies = 0
    const assemble = async (directory: string) => {
      assemblies++
      await writeFile(join(directory, 'host.js'), 'export const bootstrap = 1')
      return { entrypoint: 'host.js' }
    }
    const first = await prepareDevelopmentHost({
      cacheRoot: join(root, 'cache'),
      identity: spec,
      assemble,
    })
    await writeFile(join(root, 'application.ts'), 'export const changed = true')
    const second = await prepareDevelopmentHost({
      cacheRoot: join(root, 'cache'),
      identity: spec,
      assemble,
    })
    expect(first.cacheHit).toBe(false)
    expect(second.cacheHit).toBe(true)
    expect(second.entrypoint).toBe(first.entrypoint)
    expect(assemblies).toBe(1)
    expect(first.verifiedBytes).toBe('native-host-v1'.length)
    expect(
      (await developmentHostKey({ ...spec, configuration: '{"protocol":1,"origin":"app://test"}' }))
        .key
    ).toBe(first.key)
    for (const changed of [
      { ...spec, nativeAbi: '2' },
      { ...spec, appId: 'other.app' },
      { ...spec, engineVersion: 'cef:157' },
      { ...spec, configuration: '{"origin":"app://different"}' },
    ])
      expect((await developmentHostKey(changed)).key).not.toBe(first.key)
    await writeFile(join(root, 'native'), 'native-host-v2')
    await expect(
      prepareDevelopmentHost({ cacheRoot: join(root, 'cache'), identity: spec, assemble })
    ).rejects.toMatchObject({ code: 'INPUT_INTEGRITY' })
    expect(assemblies).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('simultaneous cold preparations publish one complete host and refuse corrupt reuse', async () => {
  const root = await temporary()
  try {
    const spec = await identity(root)
    let assemblies = 0
    const assemble = async (directory: string) => {
      assemblies++
      await Bun.sleep(50)
      await writeFile(join(directory, 'host.js'), 'complete')
      return { entrypoint: 'host.js' }
    }
    const [first, second] = await Promise.all([
      prepareDevelopmentHost({ cacheRoot: join(root, 'cache'), identity: spec, assemble }),
      prepareDevelopmentHost({ cacheRoot: join(root, 'cache'), identity: spec, assemble }),
    ])
    expect(assemblies).toBe(1)
    expect(first.key).toBe(second.key)
    expect([first.cacheHit, second.cacheHit].sort()).toEqual([false, true])
    await writeFile(first.entrypoint, 'corrupt!')
    await expect(
      prepareDevelopmentHost({ cacheRoot: join(root, 'cache'), identity: spec, assemble })
    ).rejects.toMatchObject({ code: 'CACHE_INTEGRITY' })
    expect(assemblies).toBe(1)
    expect((await readdir(join(root, 'cache'))).filter((path) => path.endsWith('.lock'))).toEqual(
      []
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('failed assembly and late input changes clean only owned staging and locks', async () => {
  const root = await temporary()
  try {
    const spec = await identity(root)
    await expect(
      prepareDevelopmentHost({
        cacheRoot: join(root, 'cache'),
        identity: spec,
        assemble: async (directory) => {
          await writeFile(join(directory, 'host.js'), 'candidate')
          await writeFile(join(root, 'native'), 'changed-during-assembly')
          return { entrypoint: 'host.js' }
        },
      })
    ).rejects.toMatchObject({ code: 'INPUT_INTEGRITY' })
    expect(await readdir(join(root, 'cache'))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test.skipIf(process.platform === 'win32')(
  'prepared-host links cannot escape the selected host inventory',
  async () => {
    const root = await temporary()
    try {
      const spec = await identity(root)
      await expect(
        prepareDevelopmentHost({
          cacheRoot: join(root, 'cache'),
          identity: spec,
          assemble: async (directory) => {
            await writeFile(join(directory, 'host.js'), 'candidate')
            await symlink('../../native', join(directory, 'escape'))
            return { entrypoint: 'host.js' }
          },
        })
      ).rejects.toMatchObject({ code: 'CACHE_INTEGRITY' })
      expect(await readdir(join(root, 'cache'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

async function fixture(root: string): Promise<void> {
  for (const path of ['backend', 'frontend', 'shared', 'generated']) await mkdir(join(root, path))
  await writeFile(join(root, 'config.json'), '{"protocol":1}')
  await writeFile(join(root, 'shared/value.ts'), 'export const value = 1')
  await writeFile(join(root, 'generated/value.ts'), 'export const generated = 10')
  await writeFile(
    join(root, 'backend/main.ts'),
    [
      "import { parentPort } from 'node:worker_threads'",
      "import { value } from '../shared/value.ts'",
      "import { generated } from '../generated/value.ts'",
      'parentPort!.on("message", () => {})',
      'parentPort!.postMessage(value + generated)',
    ].join('\n')
  )
  await writeFile(join(root, 'frontend/main.ts'), 'export const frontend = true')
}
function workerAdapter() {
  let worker: Worker | undefined
  let value: unknown
  let replacements = 0
  let shutdowns = 0
  const reload = async (bundle: DevelopmentBundle): Promise<void> => {
    const candidate = new Worker(bundle.entry)
    candidate.on('error', () => {})
    try {
      value = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Worker startup timed out')), 3000)
        candidate.once('message', (message: unknown) => {
          clearTimeout(timeout)
          resolve(message)
        })
        candidate.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
      })
    } catch (error) {
      await candidate.terminate()
      throw Object.assign(error instanceof Error ? error : new Error('Worker preparation failed'), {
        candidateRetired: true,
      })
    }
    const old = worker
    worker = candidate
    if (old) await old.terminate()
    replacements++
  }
  const shutdown = async (): Promise<void> => {
    shutdowns++
    if (worker) await worker.terminate()
    worker = undefined
  }
  return {
    reload,
    shutdown,
    value: () => value,
    replacements: () => replacements,
    shutdowns: () => shutdowns,
  }
}
function options(
  root: string,
  adapter: ReturnType<typeof workerAdapter>,
  extra: Partial<DevelopmentSessionOptions> = {}
): DevelopmentSessionOptions {
  return {
    projectRoot: root,
    entrypoint: 'backend/main.ts',
    backendRoots: ['backend'],
    frontendRoots: ['frontend'],
    sharedRoots: ['shared'],
    generatedRoots: ['generated'],
    configurationFile: 'config.json',
    cacheRoot: '.bunly/dev',
    watch: false,
    debounceMs: 0,
    reload: adapter.reload,
    shutdown: adapter.shutdown,
    ...extra,
  }
}
test('actual fresh Worker bundles replace changed dependencies independently from frontend HMR', async () => {
  const root = await temporary()
  let session: DevelopmentSession | undefined
  try {
    await fixture(root)
    const adapter = workerAdapter(),
      notices: string[][] = [],
      diagnostics: DevelopmentDiagnostic[] = []
    session = await DevelopmentSession.start(
      options(root, adapter, {
        frontendChanged: async (files) => {
          notices.push([...files])
        },
        onDiagnostic: (event) => {
          diagnostics.push(event)
        },
      })
    )
    const owner = session.instanceDirectory
    expect(adapter.value()).toBe(11)
    await writeFile(join(root, 'frontend/main.ts'), 'export const frontend = 2')
    expect((await session.invalidate(['frontend/main.ts'])).action).toBe('frontend')
    expect(adapter.replacements()).toBe(1)
    await writeFile(join(root, 'shared/value.ts'), 'export const value = 2')
    expect((await session.invalidate(['shared/value.ts'])).action).toBe('both')
    expect(adapter.value()).toBe(12)
    await writeFile(join(root, 'generated/value.ts'), 'export const generated = 20')
    expect((await session.invalidate(['generated/value.ts'])).action).toBe('both')
    expect(adapter.value()).toBe(22)
    expect(session.instanceDirectory).toBe(owner)
    expect(session.diagnostics().retainedBundles).toBe(1)
    expect(session.diagnostics().dependencies).toBe(3)
    expect(notices).toHaveLength(3)
    expect(diagnostics.filter((event) => event.event === 'build')).toHaveLength(3)
    const generation = (await readdir(owner)).find((path) => path.startsWith('generation-'))!
    expect(await readFile(join(owner, generation, 'application.js'), 'utf8')).toContain(
      'sourceMappingURL='
    )
    expect(
      JSON.parse(await readFile(join(owner, generation, 'application.js.map'), 'utf8')).sources
        .length
    ).toBeGreaterThan(0)
    await session.close()
    expect(adapter.shutdowns()).toBe(1)
    expect(session.diagnostics().retainedBundles).toBe(0)
    await expect(lstatDirectory(owner)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await session?.close()
    await rm(root, { recursive: true, force: true })
  }
})
async function lstatDirectory(path: string): Promise<readonly string[]> {
  return readdir(path)
}
test('an over-limit dependency candidate preserves the serving generation and complete graph', async () => {
  const root = await temporary()
  let session: DevelopmentSession | undefined
  try {
    await fixture(root)
    const entry = join(root, 'backend/main.ts'),
      original = await readFile(entry, 'utf8'),
      adapter = workerAdapter(),
      diagnostics: DevelopmentDiagnostic[] = []
    session = await DevelopmentSession.start(
      options(root, adapter, {
        maxDependencies: 3,
        onDiagnostic: (event) => diagnostics.push(event),
      })
    )
    expect(adapter.value()).toBe(11)
    expect(session.diagnostics().dependencies).toBe(3)
    await writeFile(join(root, 'backend/extra.ts'), 'export const extra = 100')
    await writeFile(
      entry,
      "import { extra } from './extra.ts'\n" +
        original.replace('postMessage(value + generated)', 'postMessage(value + generated + extra)')
    )
    expect((await session.invalidate(['backend/main.ts'])).action).toBe('failed')
    expect(adapter.value()).toBe(11)
    expect(adapter.replacements()).toBe(1)
    expect(session.diagnostics().dependencies).toBe(3)
    expect(session.diagnostics().retainedBundles).toBe(1)
    expect(session.diagnostics().restartRequired).toBe(false)
    expect(
      diagnostics
        .filter((event) => event.event === 'error')
        .map(({ stage, code }) => ({ stage, code }))
    ).toEqual([{ stage: 'bundle', code: 'CAPACITY' }])
    await writeFile(entry, original)
    await writeFile(join(root, 'shared/value.ts'), 'export const value = 2')
    expect((await session.invalidate(['backend/main.ts'])).action).toBe('reloaded')
    expect(adapter.value()).toBe(12)
    expect(adapter.replacements()).toBe(2)
  } finally {
    await session?.close()
    await rm(root, { recursive: true, force: true })
  }
})
test('frontend edits without an integration callback do not claim a notification', async () => {
  const root = await temporary()
  let session: DevelopmentSession | undefined
  try {
    await fixture(root)
    const adapter = workerAdapter(),
      diagnostics: DevelopmentDiagnostic[] = []
    session = await DevelopmentSession.start(
      options(root, adapter, {
        onDiagnostic: (event) => {
          diagnostics.push(event)
        },
      })
    )
    const result = await session.invalidate(['frontend/main.ts'])
    expect(result.action).toBe('frontend')
    expect(result.frontendNotified).toBe(false)
    expect(result.backendReplaced).toBe(false)
    expect(session.diagnostics().frontendEvents).toBe(1)
    expect(adapter.replacements()).toBe(1)
    expect(diagnostics.some((event) => event.message.includes('external tooling owns HMR'))).toBe(
      true
    )
  } finally {
    await session?.close()
    await rm(root, { recursive: true, force: true })
  }
})
test('syntax and initialization failures retain serving code and preserve source locations', async () => {
  const root = await temporary()
  let session: DevelopmentSession | undefined
  try {
    await fixture(root)
    const adapter = workerAdapter(),
      diagnostics: DevelopmentDiagnostic[] = []
    session = await DevelopmentSession.start(
      options(root, adapter, {
        onDiagnostic: (event) => {
          diagnostics.push(event)
        },
      })
    )
    await writeFile(join(root, 'shared/value.ts'), 'export const value = ;')
    expect((await session.invalidate(['shared/value.ts'])).action).toBe('failed')
    expect(adapter.value()).toBe(11)
    expect(adapter.replacements()).toBe(1)
    expect(
      diagnostics.some(
        (event) => event.code === 'BUILD_FAILED' && event.location?.file === 'shared/value.ts'
      )
    ).toBe(true)
    await writeFile(
      join(root, 'shared/value.ts'),
      'throw new Error("fixture-init-failure"); export const value = 2'
    )
    expect((await session.invalidate(['shared/value.ts'])).action).toBe('failed')
    expect(adapter.replacements()).toBe(1)
    await writeFile(join(root, 'shared/value.ts'), 'export const value = 3')
    expect((await session.invalidate(['shared/value.ts'])).backendReplaced).toBe(true)
    expect(adapter.value()).toBe(13)
    expect(session.diagnostics().retainedBundles).toBe(1)
  } finally {
    await session?.close()
    await rm(root, { recursive: true, force: true })
  }
})
test('broken config leaves the serving generation usable and repaired config requires restart', async () => {
  const root = await temporary()
  let session: DevelopmentSession | undefined
  try {
    await fixture(root)
    const adapter = workerAdapter(),
      reasons: string[] = []
    session = await DevelopmentSession.start(
      options(root, adapter, {
        restartRequired: (reason) => {
          reasons.push(reason)
        },
      })
    )
    await writeFile(join(root, 'config.json'), '{broken')
    await writeFile(join(root, 'shared/value.ts'), 'export const value = 4')
    expect((await session.invalidate(['shared/value.ts', 'frontend/main.ts'])).action).toBe(
      'failed'
    )
    expect(adapter.value()).toBe(11)
    expect(session.diagnostics().restartRequired).toBe(false)
    await writeFile(join(root, 'config.json'), '{"protocol":2}')
    expect((await session.invalidate(['shared/value.ts'])).action).toBe('restart-required')
    expect(adapter.replacements()).toBe(1)
    expect(reasons[0]).toContain('loses managed resource persistence')
    expect((await session.invalidate(['backend/main.ts'])).action).toBe('restart-required')
  } finally {
    await session?.close()
    await rm(root, { recursive: true, force: true })
  }
})
test('parallel instances isolate generated code, refuse duplicate ownership, and retain external HMR server', async () => {
  const root = await temporary()
  let first: DevelopmentSession | undefined, second: DevelopmentSession | undefined
  const external = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('frontend'),
  })
  try {
    await fixture(root)
    const a = workerAdapter(),
      b = workerAdapter(),
      c = workerAdapter()
    const frontendOrigin = `http://127.0.0.1:${external.port}`
    first = await DevelopmentSession.start(
      options(root, a, { instanceId: 'first', diagnosticPort: 0, frontendOrigin })
    )
    second = await DevelopmentSession.start(
      options(root, b, { instanceId: 'second', diagnosticPort: 0, frontendOrigin })
    )
    expect(first.instanceDirectory).not.toBe(second.instanceDirectory)
    expect(first.diagnostics().diagnosticPort).not.toBe(second.diagnostics().diagnosticPort)
    await expect(
      DevelopmentSession.start(options(root, c, { instanceId: 'first' }))
    ).rejects.toMatchObject({ code: 'INSTANCE_BUSY' })
    const response = await fetch(
      `http://127.0.0.1:${first.diagnostics().diagnosticPort}/__bunly/health`
    )
    expect((await response.json()).replacements).toBe(1)
    await first.close()
    expect(await (await fetch(frontendOrigin)).text()).toBe('frontend')
    expect(b.value()).toBe(11)
  } finally {
    await first?.close()
    await second?.close()
    await external.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
test('occupied diagnostic ports and unavailable frontend fail without moving to another endpoint', async () => {
  const root = await temporary()
  const occupied = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('owned') })
  try {
    await fixture(root)
    const a = workerAdapter()
    await expect(
      DevelopmentSession.start(options(root, a, { diagnosticPort: occupied.port! }))
    ).rejects.toMatchObject({ code: 'PORT_IN_USE' })
    expect(a.shutdowns()).toBe(1)
    expect(await (await fetch(`http://127.0.0.1:${occupied.port}`)).text()).toBe('owned')
    const missing = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const origin = `http://127.0.0.1:${missing.port}`
    await missing.stop(true)
    await expect(
      DevelopmentSession.start(
        options(root, workerAdapter(), { frontendOrigin: origin, frontendTimeoutMs: 100 })
      )
    ).rejects.toMatchObject({ code: 'FRONTEND_UNAVAILABLE' })
  } finally {
    await occupied.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
test('coalesced edits settle all callers with one replacement and unknown cleanup halts future edits', async () => {
  const root = await temporary()
  let session: DevelopmentSession | undefined
  try {
    await fixture(root)
    const adapter = workerAdapter()
    let fail = false
    session = await DevelopmentSession.start(
      options(root, adapter, {
        debounceMs: 10,
        reload: async (bundle) => {
          if (fail)
            throw Object.assign(new Error('uncertain'), {
              restartRequired: true,
              candidateRetired: false,
            })
          return adapter.reload(bundle)
        },
      })
    )
    await writeFile(join(root, 'shared/value.ts'), 'export const value = 5')
    const results = await Promise.all(
      Array.from({ length: 10 }, () => session!.invalidate(['shared/value.ts']))
    )
    expect(new Set(results.map((result) => result.sequence)).size).toBe(1)
    expect(adapter.replacements()).toBe(2)
    fail = true
    expect((await session.invalidate(['backend/main.ts'])).action).toBe('restart-required')
    expect(session.diagnostics().retainedBundles).toBe(2)
    expect((await session.invalidate(['backend/main.ts'])).action).toBe('restart-required')
    expect(session.diagnostics().retainedBundles).toBe(2)
  } finally {
    await session?.close()
    await rm(root, { recursive: true, force: true })
  }
})
test.each(['native', 'malformed-cross-drive'] as const)(
  'filesystem events observe transitive dependencies outside the declared source roots (%s metafile)',
  async (metadata) => {
    const parent = await temporary(),
      root = join(parent, 'app')
    let session: DevelopmentSession | undefined
    let restoreBuild: (() => void) | undefined
    let metadataInputs: string[] = []
    try {
      await mkdir(root)
      await fixture(root)
      await writeFile(join(parent, 'external.ts'), 'export const external = 20')
      await writeFile(
        join(root, 'backend/main.ts'),
        [
          "import { parentPort } from 'node:worker_threads'",
          "import { external } from '../../external.ts'",
          'parentPort!.on("message", () => {})',
          'parentPort!.postMessage(external)',
        ].join('\n')
      )
      if (metadata === 'malformed-cross-drive') {
        const build = Bun.build.bind(Bun)
        const mock = spyOn(Bun, 'build').mockImplementation(async (config) => {
          const built = await build(config)
          if (!built.metafile) return built
          // Reproduce the observed Bun 1.4.3 C:-temp/D:-checkout display paths.
          // Actual resolver/loader execution and generated code remain real.
          const inputs = Object.fromEntries(
            Object.entries(built.metafile.inputs).map(([path, input]) => [
              `../../../../C:/bunly-metafile-display-only/${basename(parent)}/${basename(path)}`,
              input,
            ])
          )
          metadataInputs = Object.keys(inputs)
          return { ...built, metafile: { ...built.metafile, inputs } }
        })
        restoreBuild = () => mock.mockRestore()
      }
      const adapter = workerAdapter(),
        diagnostics: DevelopmentDiagnostic[] = []
      try {
        session = await DevelopmentSession.start(
          options(root, adapter, {
            watch: true,
            debounceMs: 10,
            onDiagnostic: (event) => diagnostics.push(event),
          })
        )
      } catch (cause) {
        // Keep the exact startup failure and expose the paths Bun actually loaded.
        // Hosted Windows uses a different drive for its checkout and temp directory;
        // without this receipt BUILD_FAILED alone hides build versus watcher failures.
        const loaded: string[] = []
        const probe = await Bun.build({
          entrypoints: [join(root, 'backend/main.ts')],
          target: 'bun',
          format: 'esm',
          metafile: true,
          throw: false,
          plugins: [
            {
              name: 'observe-fixture-input-paths',
              setup(build) {
                build.onLoad({ filter: /./ }, ({ path }) => {
                  loaded.push(path)
                })
              },
            },
          ],
        })
        const inputs = await Promise.all(
          Object.keys(probe.metafile?.inputs ?? {}).map(async (path) => ({
            path,
            resolved: resolve(path),
            exists: await lstat(resolve(path)).then(
              (stat) => stat.isFile(),
              () => false
            ),
          }))
        )
        throw new Error(
          `Watcher startup failed: ${JSON.stringify({
            diagnostics,
            cwd: process.cwd(),
            root,
            loaded,
            inputs,
            buildSuccess: probe.success,
            buildMessages: probe.logs.map((message) => message.message),
          })}`,
          { cause }
        )
      }
      expect(adapter.value()).toBe(20)
      if (metadata === 'malformed-cross-drive') {
        expect(metadataInputs).toHaveLength(2)
        for (const path of metadataInputs)
          expect(
            await lstat(resolve(path)).then(
              () => true,
              () => false
            )
          ).toBe(false)
      }
      await writeFile(join(parent, 'external.ts'), 'export const external = 21')
      const deadline = performance.now() + 5000
      while (adapter.value() !== 21 && performance.now() < deadline) await Bun.sleep(10)
      expect(adapter.value()).toBe(21)
      await session.close()
      expect(session.diagnostics().watchedDirectories).toBe(0)
    } finally {
      restoreBuild?.()
      await session?.close()
      await rm(parent, { recursive: true, force: true })
    }
  },
  10000
)
test('shutdown cancels queued changes and waits for owned runtime completion', async () => {
  const root = await temporary()
  let session: DevelopmentSession | undefined
  try {
    await fixture(root)
    const adapter = workerAdapter()
    session = await DevelopmentSession.start(options(root, adapter, { debounceMs: 100 }))
    await Bun.sleep(0)
    const pending = session.invalidate(['backend/main.ts'])
    const outcome = pending.then(
      () => ({ code: 'UNEXPECTED_SUCCESS' }),
      (error: unknown) => error
    )
    await session.close()
    expect(await outcome).toMatchObject({ code: 'CLOSED' })
    expect(adapter.replacements()).toBe(1)
    expect(adapter.shutdowns()).toBe(1)
    await expect(session.invalidate(['backend/main.ts'])).rejects.toBeInstanceOf(DevelopmentError)
  } finally {
    await session?.close()
    await rm(root, { recursive: true, force: true })
  }
})
