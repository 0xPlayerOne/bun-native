/** Real pinned desktop adapters for the common outcome. No simulated launch fallback. */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { referenceInstallation } from '../adapters/references/packages.ts'
import { inventory } from '../lib/inventory.ts'
import { cefIdentityFromObservation, type CefIdentity } from '../lib/cef-identity.ts'
import {
  assertCleanCommand,
  observedCommand,
  observationsPermitFixtureRemoval,
  type CommandObservation,
  type ObservedCommand,
} from '../lib/observed-command.ts'
import { observeNativeShutdown, requireNativeShutdown } from '../foundation/native-shutdown.ts'
import {
  acceptComparisonRows,
  COMPARISON_PLAN,
  createComparisonProbe,
  type ComparisonFramework,
  type ComparisonLaunch,
  type ComparisonRow,
} from './managed-comparison.ts'

const root = resolve(import.meta.dir, '../..')
const fixtures = join(root, 'benchmarks/fixtures/managed-comparison')
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
export interface ComparisonAdapterOptions {
  readonly output: string
  readonly prebuilt: string
  readonly referenceRoot: string
  readonly mirinLock: string
}
interface CommandRecord {
  phase: string
  report: string
  observation: CommandObservation | null
}
export interface ComparisonAdapterResult {
  framework: ComparisonFramework
  passed: boolean
  rows: ComparisonRow[]
  commands: CommandRecord[]
  engine: CefIdentity | null
  engineLibrary: string | null
  rendererAssets: Record<string, { bytes: number; sha256: string }> | null
  acceptance: ReturnType<typeof acceptComparisonRows> | null
  installation: unknown
  artifacts: unknown
  failure: string | null
  retainedFixture: boolean
  processSandbox: 'unverified'
}

async function macApplication(
  directory: string
): Promise<{ application: string; executable: string }> {
  const applications: string[] = []
  const visit = async (path: string, depth: number): Promise<void> => {
    assert.ok(depth <= 4, 'Unexpected native artifact layout')
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = join(path, entry.name)
      if (entry.name.endsWith('.app')) applications.push(child)
      else await visit(child, depth + 1)
    }
  }
  await visit(directory, 0)
  assert.equal(applications.length, 1, 'Expected exactly one generated app')
  const application = applications[0]!
  const plist = Bun.spawnSync(
    [
      '/usr/libexec/PlistBuddy',
      '-c',
      'Print :CFBundleExecutable',
      join(application, 'Contents/Info.plist'),
    ],
    { timeout: 5000 }
  )
  assert.equal(plist.exitCode, 0)
  const name = plist.stdout.toString().trim()
  assert.ok(name && basename(name) === name)
  const executable = await realpath(join(application, 'Contents/MacOS', name))
  assert.ok(relative(await realpath(application), executable).startsWith('Contents/MacOS/'))
  assert.ok((await lstat(executable)).isFile())
  return { application, executable }
}

export async function runComparisonAdapter(
  framework: ComparisonFramework,
  options: ComparisonAdapterOptions
): Promise<ComparisonAdapterResult> {
  assert.equal(
    process.platform,
    'darwin',
    'This reference app layout is qualified on macOS arm64 only'
  )
  assert.equal(process.arch, 'arm64')
  const output = resolve(options.output),
    project = join(output, 'fixture'),
    inputs = join(output, 'inputs')
  await mkdir(project, { recursive: true, mode: 0o700 })
  await mkdir(inputs, { mode: 0o700 })
  await mkdir(join(project, 'src'))
  const commands: CommandRecord[] = [],
    rows: ComparisonRow[] = []
  const result: ComparisonAdapterResult = {
    framework,
    passed: false,
    rows,
    commands,
    engine: null,
    engineLibrary: null,
    rendererAssets: null,
    acceptance: null,
    installation: null,
    artifacts: null,
    failure: null,
    retainedFixture: true,
    processSandbox: 'unverified',
  }
  const cancellation = new AbortController()
  let active: ObservedCommand | undefined
  let probe: Awaited<ReturnType<typeof createComparisonProbe>> | undefined
  let application = '',
    executable = ''
  const command = (
    phase: string,
    args: readonly string[],
    env: Record<string, string | undefined> = {},
    timeoutMs = 30_000,
    cwd = project,
    redact: readonly string[] = []
  ) => {
    const index = commands.length,
      report = `${String(index).padStart(3, '0')}-${phase}.json`
    commands.push({ phase, report, observation: null })
    const child = observedCommand(args, {
      cwd,
      output: join(output, report),
      env,
      timeoutMs,
      redact,
      signal: cancellation.signal,
    })
    const observed = child.result.then((observation) => {
      commands[index] = { phase, report, observation }
      return observation
    })
    void observed.catch(() => {})
    return { path: child.path, result: observed }
  }
  const stop = async () => {
    if (!active) return
    const owned = active
    active = undefined
    probe?.quit()
    const timer = setTimeout(
      () => cancellation.abort(new Error('Comparison ordinary shutdown deadline')),
      10_000
    )
    try {
      const observation = await owned.result
      assertCleanCommand(observation)
      if (framework === 'bunly') {
        requireNativeShutdown(observeNativeShutdown(observation))
        assert.equal(
          observation.postExitCleanup?.qualified,
          true,
          'Bunly helper/clone cleanup must be observed'
        )
        assert.equal(observation.postExitCleanup?.status, 'completed')
      }
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const pinnedTerminal = join(root, 'node_modules/@xterm/xterm')
    assert.equal(
      JSON.parse(await readFile(join(pinnedTerminal, 'package.json'), 'utf8')).version,
      '5.5.0'
    )
    const assets = {
      html: await readFile(join(fixtures, 'index.html'), 'utf8'),
      javascript: await readFile(join(fixtures, 'client.js'), 'utf8'),
      terminalJs: await readFile(join(pinnedTerminal, 'lib/xterm.js'), 'utf8'),
      terminalCss: await readFile(join(pinnedTerminal, 'css/xterm.css'), 'utf8'),
    }
    result.rendererAssets = Object.fromEntries(
      Object.entries(assets).map(([name, text]) => {
        const bytes = Buffer.from(text)
        return [name, { bytes: bytes.byteLength, sha256: hash(bytes) }]
      })
    )
    probe = await createComparisonProbe({ framework, ...assets })
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({
        name: 'bunly-private-comparison',
        version: '0.0.0',
        private: true,
        type: 'module',
      })
    )
    await copyFile(join(fixtures, 'host.ts'), join(project, 'src/host.ts'))
    const namespace = randomBytes(8).toString('hex')
    let build: () => Promise<void>
    let launchEnvironment: Record<string, string | undefined> = {}
    let nativeBefore: Awaited<ReturnType<typeof inventory>> | undefined
    if (framework === 'bunly') {
      const source = await realpath(options.prebuilt)
      assert.ok(source.endsWith('.app') && (await lstat(source)).isDirectory())
      const sourceInventory = await inventory(source)
      application = join(project, 'Bunly Comparison.app')
      await cp(source, application, { recursive: true, dereference: false })
      executable = join(application, 'Contents/MacOS/bunly_host')
      const resources = join(application, 'Contents/Resources'),
        backend = join(resources, 'backend')
      const runtime = JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8')) as Record<
        string,
        unknown
      >
      assert.equal(runtime['bun_version'], '1.4.3')
      assert.equal(runtime['cef_version'], '156.0.7')
      assert.equal(runtime['protocol'], 1)
      assert.equal(runtime['development_origin'], undefined)
      await rm(backend, { recursive: true, force: true })
      await mkdir(backend)
      for (const [entry, name] of [
        ['scripts/cef-bootstrap.ts', 'main.js'],
        ['benchmarks/fixtures/managed-comparison/bunly.ts', 'application.js'],
        ['packages/runtime/src/service-reload-runner.ts', 'service-reload-runner.js'],
      ] as const) {
        const built = await Bun.build({
          entrypoints: [join(root, entry)],
          outdir: backend,
          naming: name,
          target: 'bun',
          format: 'esm',
          sourcemap: 'linked',
          minify: false,
        })
        assert.equal(built.success, true, 'Comparison stable backend build failed')
      }
      const signer = join(inputs, 'sign.py')
      await writeFile(
        signer,
        [
          'import sys,subprocess',
          'from pathlib import Path',
          `sys.path.insert(0,${JSON.stringify(join(root, 'scripts'))})`,
          'from qualify_adhoc_signing import targets',
          `for p in targets(Path(${JSON.stringify(application)})): subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(p)],check=True,capture_output=True)`,
          '',
        ].join('\n')
      )
      assertCleanCommand(
        await command('sign-private-app', [process.env['PYTHON'] ?? 'python3', signer]).result
      )
      nativeBefore = await inventory(application)
      result.artifacts = {
        input: sourceInventory,
        prepared: nativeBefore,
        nativeCopies: 1,
        nativeCompilations: 0,
        originalUnchanged: false,
        preparedUnchanged: false,
      }
      result.installation = {
        bun: Bun.version,
        runtime,
        source: 'explicitly-selected-prebuilt-input',
      }
      await writeFile(
        join(project, 'src/service.ts'),
        "import { revision } from './revision.ts'; export default () => ({schema:'comparison:1',handlers:{revision:()=>JSON.stringify(revision())}});\n"
      )
      build = async () => {}
      launchEnvironment = {
        BUNLY_COMPARISON_PROJECT: project,
        BUNLY_SERVICE_RUNNER: join(backend, 'service-reload-runner.js'),
        BUNLY_CACHE_DIR: join(project, 'browser-profile'),
        BUNLY_BENCH_SANDBOX: '1',
        PATH: '',
      }
    } else {
      await copyFile(join(fixtures, framework + '.ts.txt'), join(project, 'src', framework + '.ts'))
      if (framework === 'electrobun') {
        const baseline = join(resolve(options.referenceRoot), 'benchmarks/adapters/electrobun')
        const local = join(inputs, 'electrobun')
        await mkdir(local)
        await cp(join(baseline, 'node_modules'), join(local, 'node_modules'), {
          recursive: true,
          dereference: false,
        })
        const bootstrap = join(local, 'node_modules/electrobun/bin/electrobun.cjs')
        const manifest = await readFile(join(local, 'node_modules/electrobun/package.json'))
        assert.equal(JSON.parse(manifest.toString()).version, '2.0.3-beta.26')
        const hutch = join(inputs, 'hutch-home')
        await cp(join(resolve(options.referenceRoot), '.bunly/benchmarks/hutch-home'), hutch, {
          recursive: true,
          dereference: false,
        })
        result.installation = {
          version: '2.0.3-beta.26',
          manifestSha256: hash(manifest),
          bootstrapSha256: hash(await readFile(bootstrap)),
          provenance:
            'installed-version-and-observed-file-hashes; registry-source-not-authenticated',
        }
        let config = await readFile(
          join(root, 'benchmarks/adapters/electrobun/template/electrobun.config.ts.txt'),
          'utf8'
        )
        config = config
          .replace('BunlyBaseline', 'BunlyComparison' + namespace)
          .replace('dev.bunly.benchmark.electrobun', 'dev.bunly.comparison.' + namespace)
          .replace('src/main.ts', 'src/electrobun.ts')
        await writeFile(join(project, 'electrobun.config.ts'), config)
        await copyFile(
          join(root, 'benchmarks/adapters/electrobun/template/hutch.config.ts.txt'),
          join(project, 'hutch.config.ts')
        )
        const environment = {
          HUTCH_HOME: hutch,
          PATH: dirname(process.execPath) + ':' + (process.env['PATH'] ?? ''),
        }
        for (const args of [['prepare'], ['config', '--env=dev']])
          assertCleanCommand(
            await command(args[0]!, [process.execPath, bootstrap, ...args], environment, 240_000)
              .result
          )
        build = async () => {
          assertCleanCommand(
            await command(
              'build',
              [process.execPath, bootstrap, 'build', '--env=dev'],
              environment,
              240_000
            ).result
          )
          const layout = await macApplication(join(project, 'build'))
          application = layout.application
          executable = layout.executable
        }
      } else {
        const original = join(resolve(options.referenceRoot), '.bunly/references/mirin')
        await referenceInstallation('mirin', original, options.mirinLock)
        const local = join(inputs, 'mirin')
        await mkdir(local)
        await copyFile(join(original, 'bun.lock'), join(local, 'bun.lock'))
        await cp(join(original, 'node_modules'), join(local, 'node_modules'), {
          recursive: true,
          dereference: false,
        })
        const installation = await referenceInstallation('mirin', local, options.mirinLock)
        result.installation = {
          lockSha256: installation.lockSha256,
          packages: installation.packages,
          sourceVerified: false,
        }
        await symlink(installation.nodeModules, join(project, 'node_modules'), 'dir')
        let config = await readFile(
          join(root, 'benchmarks/fixtures/desktop-edit/mirin.config.ts.txt'),
          'utf8'
        )
        config = config
          .replace('BunlyReference', 'BunlyComparison' + namespace)
          .replace('dev.bunly.benchmark.mirin', 'dev.bunly.comparison.' + namespace)
        await writeFile(join(project, 'mirin.config.ts'), config)
        await writeFile(
          join(project, 'vite.config.ts'),
          'export default { build: { outDir: "dist" } };\n'
        )
        await writeFile(
          join(project, 'index.html'),
          '<!doctype html><title>Private comparison bootstrap</title>'
        )
        const environment = {
          MIRIN_SIGN_IDENTITY: '-',
          MIRIN_RELEASE_BASE_URL: '',
          MIRIN_RELEASE_CHANNEL: '',
          MIRIN_APP_VERSION: '',
          BUN_INSTALL_CACHE_DIR: join(inputs, 'bun-cache'),
          PATH: dirname(process.execPath) + ':' + (process.env['PATH'] ?? ''),
        }
        build = async () => {
          assertCleanCommand(
            await command(
              'build',
              [process.execPath, installation.entry, 'build'],
              environment,
              240_000
            ).result
          )
          const layout = await macApplication(join(project, 'build'))
          application = layout.application
          executable = layout.executable
        }
        launchEnvironment = environment
      }
    }
    const launch = (configuration: ComparisonLaunch) =>
      command(
        'app',
        [executable],
        {
          ...launchEnvironment,
          BUNLY_COMPARISON_ORIGIN: configuration.origin,
          BUNLY_COMPARISON_HOST_TOKEN: configuration.hostToken,
          BUNLY_COMPARISON_RENDERER_TOKEN: configuration.rendererToken,
        },
        framework === 'bunly' ? 120_000 : 35_000,
        dirname(executable),
        [configuration.hostToken, configuration.rendererToken]
      )
    for (let revision = 0; revision <= COMPARISON_PLAN.edits; revision++) {
      const role =
        revision === 0 ? 'initial' : revision <= COMPARISON_PLAN.warmups ? 'warmup' : 'measurement'
      if (rows.some((row) => row.status !== 'passed')) {
        rows.push({
          revision,
          role,
          status: 'not-executed',
          elapsedMs: null,
          observation: null,
          failure: 'Prior fixed-plan row failed; no retry',
        })
        continue
      }
      const start = performance.now()
      try {
        const completion = probe.expect(revision)
        await writeFile(
          join(project, 'src/revision.ts'),
          `export function revision() { return ${revision}; }\n`
        )
        if (framework === 'bunly' && revision > 0) probe.edit(revision)
        else {
          await stop()
          // stop sets quit for the prior launch; expect already arms the next revision.
          await build()
          probe.resume()
          active = launch(probe.configuration)
        }
        assert.ok(active)
        const observation = await Promise.race([
          completion,
          active.result.then(() => {
            throw new Error('Desktop exited before common renderer outcome')
          }),
        ])
        rows.push({
          revision,
          role,
          status: 'passed',
          elapsedMs: performance.now() - start,
          observation,
          failure: null,
        })
      } catch (error) {
        rows.push({
          revision,
          role,
          status: 'failed',
          elapsedMs: performance.now() - start,
          observation: null,
          failure: error instanceof Error ? error.message : 'Comparison step failed',
        })
      }
    }
    await stop()
    if (application) {
      const library = await realpath(
        join(
          application,
          'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
        )
      )
      const hasher = new Bun.CryptoHasher('sha256')
      for await (const chunk of Bun.file(library).stream()) hasher.update(chunk)
      const digest = hasher.digest('hex')
      result.engineLibrary = relative(application, library).split('\\').join('/')
      result.engine = cefIdentityFromObservation(
        await command('cef-identity', [
          process.env['PYTHON'] ?? 'python3',
          join(root, 'scripts/probe_cef_identity.py'),
          '--library',
          library,
          '--sha256',
          digest,
        ]).result,
        digest
      )
    }
    if (framework === 'bunly') {
      assert.deepEqual(
        await inventory(application),
        nativeBefore,
        'Prepared native app changed during ordinary backend edits'
      )
      const artifacts = result.artifacts as {
        input: unknown
        originalUnchanged: boolean
        preparedUnchanged: boolean
      }
      assert.deepEqual(
        await inventory(options.prebuilt),
        artifacts.input,
        'Original selected app was changed'
      )
      artifacts.originalUnchanged = true
      artifacts.preparedUnchanged = true
    } else result.artifacts = await inventory(application)
    result.acceptance = acceptComparisonRows(framework, rows)
    result.passed = true
  } catch (error) {
    result.failure = error instanceof Error ? error.message : 'Comparison setup failed'
  } finally {
    try {
      await stop()
    } catch {
      result.passed = false
      result.failure = 'Ordinary process shutdown failed'
    }
    await probe?.close()
    if (observationsPermitFixtureRemoval(commands.map((row) => row.observation))) {
      try {
        await rm(project, { recursive: true, force: true })
        await rm(inputs, { recursive: true, force: true })
        result.retainedFixture = false
      } catch {
        result.passed = false
        result.failure = 'Private comparison fixture removal failed'
      }
    } else {
      result.passed = false
      result.failure = 'Process cleanup unconfirmed; private fixture retained'
    }
    while (rows.length <= COMPARISON_PLAN.edits) {
      const revision = rows.length
      rows.push({
        revision,
        role:
          revision === 0
            ? 'initial'
            : revision <= COMPARISON_PLAN.warmups
              ? 'warmup'
              : 'measurement',
        status: 'not-executed',
        elapsedMs: null,
        observation: null,
        failure: 'Setup or prior fixed-plan row failed; no retry',
      })
    }
  }
  return result
}
