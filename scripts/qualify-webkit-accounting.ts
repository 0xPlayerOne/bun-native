/** Explicit Launch Services wrapper profile; never substituted for direct-launch baselines. */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { referenceInstallation } from '../benchmarks/adapters/references/packages.ts'
import {
  createWorkbenchDesktopProbe,
  type WorkbenchDesktopProbe,
} from '../benchmarks/lib/workbench-desktop.ts'
import {
  assertCleanCommand,
  observedCommand,
  type CommandObservation,
  type ObservedCommand,
} from '../benchmarks/lib/observed-command.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { directoryBytes } from '../benchmarks/lib/accounting.ts'
import { loadWorkbenchAssets } from './workbench.ts'

const root = resolve(import.meta.dir, '..')
const python = process.env['PYTHON'] ?? 'python3'
const templates = join(root, 'benchmarks/fixtures/desktop-edit')
const repetitions = Number(process.argv[2] ?? 3)
if (Bun.version !== '1.4.3') throw new Error('Use the pinned Bun 1.4.3 for this profile')
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('This qualified wrapper profile requires macOS arm64')
if (
  !Number.isSafeInteger(repetitions) ||
  repetitions < 1 ||
  repetitions > 10 ||
  process.argv.length > 3
)
  throw new Error('Expected 1..10 independent repetitions')
const parent = join(root, '.bunly/acceptance/m2-closeout')
await mkdir(parent, { recursive: true, mode: 0o700 })
const directory = await mkdtemp(join(parent, 'webkit-accounting-'))
const sourceBefore = sourceIdentity(root)
const trials: Record<string, unknown>[] = []
const report = {
  schema: 1,
  createdAt: new Date().toISOString(),
  driverBun: Bun.version,
  profile: 'butter-source-helper-primed+launchservices-wrapper+local-adhoc',
  runClass: 'local-smoke',
  sourceBefore,
  plan: { repetitions, warmups: 1, sampleSeconds: 5 },
  trials,
  passed: false,
  limitations: [
    'This .app wrapper and Launch Services path are not the previous direct-launch profile',
    'Self-responsibility and separate coalitions are mandatory: shared controller identity is rejected',
    'Compiler and ad-hoc wrapper-signing costs stay present; no production certificate is selected',
    'Observed RSS includes app descendants and attributed system WebKit XPCs, not unique physical RAM',
    'No OS service is signalled or reparented by the collector; same-user shared services are never claimed',
    'No controlled calibration or comparison with unmatched Chromium/security profiles',
  ],
}

async function run(trial: number, warmup: boolean) {
  const workspace = join(directory, `${warmup ? 'warmup' : 'trial'}-${trial}`)
  await mkdir(workspace, { mode: 0o700 })
  const observations: { stage: string; observation: CommandObservation }[] = []
  const stages: { stage: string; elapsedMs: number }[] = []
  const row: Record<string, unknown> = { trial, warmup, passed: false, observations, stages }
  trials.push(row)
  let probe: WorkbenchDesktopProbe | undefined
  let opened: ObservedCommand | undefined
  let registered: ObservedCommand | undefined
  const credentials: string[] = []
  const environment: Record<string, string | undefined> = {
    ...process.env,
    HOME: join(workspace, 'home'),
    USERPROFILE: join(workspace, 'home'),
    BUN_INSTALL_CACHE_DIR: join(workspace, 'home/cache'),
    PATH: dirname(process.execPath) + ':' + (process.env['PATH'] ?? ''),
  }
  async function command(stage: string, args: readonly string[], cwd = workspace) {
    const start = performance.now()
    const result = await observedCommand(args, {
      cwd,
      output: join(workspace, `command-${observations.length}.json`),
      env: environment,
      timeoutMs: 240000,
      redact: credentials,
    }).result
    observations.push({ stage, observation: result })
    assertCleanCommand(result)
    stages.push({ stage, elapsedMs: performance.now() - start })
    return result
  }
  try {
    const lock = await readFile(
      join(root, 'benchmarks/adapters/references/locks/butter-source.bun.lock')
    )
    const installation = await referenceInstallation(
      'butter',
      join(root, '.bunly/references/butter'),
      createHash('sha256').update(lock).digest('hex')
    )
    for (const path of ['src', 'home']) await mkdir(join(workspace, path))
    await symlink(installation.nodeModules, join(workspace, 'node_modules'), 'dir')
    for (const name of ['host.ts', 'butter.ts'])
      await copyFile(join(templates, name + '.txt'), join(workspace, 'src', name))
    await copyFile(join(templates, 'butter.yaml.txt'), join(workspace, 'butter.yaml'))
    await writeFile(join(workspace, 'src/revision.ts'), "export const revision = 'initial';\n")
    await writeFile(
      join(workspace, 'index.html'),
      '<!doctype html><title>Private accounting fixture</title>'
    )
    await writeFile(
      join(workspace, 'package.json'),
      JSON.stringify({ name: 'bunly-private-accounting', private: true, type: 'module' })
    )
    await command('upstream-compile', [process.execPath, installation.entry, 'compile'])
    const app = join(workspace, 'Observed.app'),
      executable = join(app, 'Contents/MacOS/BunlyObserved')
    await mkdir(dirname(executable), { recursive: true })
    await copyFile(join(workspace, 'dist/bunlyreference'), executable)
    await writeFile(
      join(app, 'Contents/Info.plist'),
      JSON.stringify({
        CFBundleExecutable: 'BunlyObserved',
        CFBundleIdentifier: 'dev.bunly.accounting.' + randomBytes(8).toString('hex'),
        CFBundleName: 'BunlyObserved',
        CFBundlePackageType: 'APPL',
        CFBundleVersion: '1',
        NSHighResolutionCapable: true,
      })
    )
    await command('wrapper-plist', [
      '/usr/bin/plutil',
      '-convert',
      'xml1',
      join(app, 'Contents/Info.plist'),
    ])
    // This explicitly local re-signing operation is not Developer ID release signing.
    await command('wrapper-adhoc-sign', ['/usr/bin/codesign', '--force', '--sign', '-', app])
    await command('wrapper-signature-verify', ['/usr/bin/codesign', '--verify', '--strict', app])
    row['wrapperBytes'] = await directoryBytes(
      'installed',
      app,
      'Actual local .app wrapper bytes, not the default standalone or physical RAM'
    )
    const state = { token: randomBytes(24).toString('hex'), counter: 17 }
    const stateFile = join(workspace, 'state.json')
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 })
    probe = await createWorkbenchDesktopProbe(
      {
        revision: 'initial',
        state: state.token,
        counter: state.counter,
        framework: 'Butter',
        version: '1.6.3',
        html: await readFile(join(templates, 'index.html'), 'utf8'),
        javascript: await readFile(join(templates, 'client.js'), 'utf8'),
      },
      await loadWorkbenchAssets()
    )
    const config = probe.configuration
    credentials.push(config.hostToken, config.rendererToken, config.launch, state.token)
    const launchEnv = {
      HOME: join(workspace, 'home'),
      BUNLY_EDIT_ORIGIN: config.origin,
      BUNLY_EDIT_LAUNCH: config.launch,
      BUNLY_EDIT_HOST_TOKEN: config.hostToken,
      BUNLY_EDIT_RENDERER_TOKEN: config.rendererToken,
      BUNLY_EDIT_STATE: stateFile,
      BUNLY_EDIT_FRAME_ORIGIN: config.workbenchOrigin!,
    }
    const args = Object.entries(launchEnv).flatMap(([key, value]) => ['--env', key + '=' + value])
    opened = observedCommand(
      [
        '/usr/bin/open',
        '-n',
        '-W',
        '-g',
        '-o',
        join(workspace, 'app.log'),
        '--stderr',
        join(workspace, 'app-errors.log'),
        ...args,
        app,
      ],
      {
        cwd: workspace,
        output: join(workspace, 'open-process.json'),
        env: environment,
        timeoutMs: 35000,
        redact: credentials,
      }
    )
    const ready = await Promise.race([
      probe.completion,
      opened.result.then(() => {
        throw new Error('App exited before rendered readiness')
      }),
    ])
    row['workbench'] = ready.workbench
    row['hostRuntime'] = {
      framework: ready.host.framework,
      frameworkVersion: ready.host.frameworkVersion,
      runtimeVersion: ready.host.runtimeVersion,
      reportedSandbox: ready.host.sandbox,
    }
    const webkit = await command(
      'system-webkit-identity',
      [python, join(root, 'scripts/webkit_identity.py')],
      root
    )
    const nativeIdentities = webkit.stdoutTail
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter((value) => value?.provider === 'system-webkit-framework-plist')
    assert.equal(nativeIdentities.length, 1)
    row['systemWebKit'] = nativeIdentities[0]
    registered = observedCommand(
      [
        python,
        join(root, 'scripts/registered_app.py'),
        String(ready.host.pid),
        executable,
        '--timeout',
        '25',
      ],
      {
        cwd: root,
        output: join(workspace, 'registered-process.json'),
        timeoutMs: 30000,
      }
    )
    probe.requestIdle(10000)
    await Bun.sleep(1800)
    await command(
      'attributed-idle',
      [
        python,
        join(root, 'scripts/macos_app_accounting.py'),
        String(ready.host.pid),
        executable,
        '--seconds',
        '5',
        '--output',
        join(workspace, 'attributed.json'),
      ],
      root
    )
    const accounting = await Bun.file(join(workspace, 'attributed.json')).json()
    assert.equal(accounting.passed, true)
    assert.equal(accounting.rootPid, ready.host.pid)
    row['accounting'] = accounting
    row['passed'] = true
  } catch (error) {
    row['failure'] = error instanceof Error ? error.message : 'Accounting trial failed'
  } finally {
    probe?.requestQuit()
    for (const [name, observer] of [
      ['open-exit', opened],
      ['registered-exit', registered],
    ] as const) {
      if (observer) {
        try {
          const result = await observer.result
          observations.push({ stage: name, observation: result })
          assertCleanCommand(result)
        } catch {
          row['passed'] = false
          row['cleanupFailure'] = 'Application exit could not be established'
        }
      }
    }
    await probe?.close()
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  })
  console.log(
    JSON.stringify({ trial, warmup, passed: row['passed'], failure: row['failure'], directory })
  )
}
for (let trial = -1; trial < repetitions; trial++) {
  await run(trial < 0 ? 0 : trial, trial < 0)
  if (trials.some((row) => row['passed'] !== true)) break
}
report.passed = trials.length === repetitions + 1 && trials.every((row) => row['passed'] === true)
Object.assign(report, { sourceAfter: sourceIdentity(root) })
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
})
console.log(JSON.stringify({ passed: report.passed, directory }))
if (!report.passed) process.exitCode = 1
