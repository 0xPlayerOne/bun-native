import { loadWorkbenchAssets } from '../../../scripts/workbench.ts'
import { randomBytes } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve, relative } from 'node:path'
import {
  assertCleanCommand,
  observedCommand,
  observationsPermitFixtureRemoval,
  type CommandObservation,
} from '../../lib/observed-command.ts'
import {
  runDesktopEdits,
  type DesktopEditAdapter,
  type DesktopEditResult,
} from '../../lib/desktop-edits.ts'
import { desktopEditStages } from '../../lib/desktop-report.ts'
import type { StageRecord } from '../../lib/stages.ts'
import type { DesktopLaunch } from '../../lib/desktop-probe.ts'
import {
  directoryBytes,
  unavailableBytes,
  validateByteMatrix,
  type ByteObservation,
} from '../../lib/accounting.ts'
import { fileBytes } from '../../lib/accounting.ts'
import { cefIdentityFromObservation, type CefIdentity } from '../../lib/cef-identity.ts'
export type DesktopAdapterName = 'electron' | 'electrobun'
const root = resolve(import.meta.dir, '../../..')
const templates = join(root, 'benchmarks/fixtures/desktop-edit')
export const DESKTOP_ADAPTERS = {
  electron: {
    framework: 'Electron',
    version: '44.8.0',
    source: '60169b45c12488c6fda237af7f6425526a7ce5f0',
  },
  electrobun: {
    framework: 'Electrobun',
    version: '2.0.3-beta.26',
    source: 'c4bbeca07829d9b1634d31598ef6091fb19ace2a',
  },
} as const
interface CommandRecord {
  readonly phase: string
  readonly report: string
  readonly observation: CommandObservation | null
}
export interface DesktopEditTrial {
  readonly engineIdentity: CefIdentity | null
  readonly adapter: DesktopAdapterName
  readonly passed: boolean
  readonly result: DesktopEditResult | null
  readonly setupFailure: string | null
  readonly retainedFixture: string | null
  readonly commands: readonly CommandRecord[]
  readonly stages: readonly StageRecord[]
  readonly bytes: readonly ByteObservation[]
}
async function macApplication(
  project: string
): Promise<{ application: string; executable: string }> {
  const applications: string[] = []
  async function visit(path: string, depth: number): Promise<void> {
    if (depth > 3) return
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = join(path, entry.name)
      if (entry.name.endsWith('.app')) applications.push(child)
      else await visit(child, depth + 1)
    }
  }
  await visit(join(project, 'build'), 0)
  if (applications.length !== 1) throw new Error('Expected exactly one generated Electrobun app')
  const application = applications[0]!
  const info = join(application, 'Contents/Info.plist')
  const value = Bun.spawnSync(
    ['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleExecutable', info],
    { timeout: 5000 }
  )
  const name = value.stdout.toString().trim()
  if (value.exitCode !== 0 || !name || name !== basename(name))
    throw new Error('Invalid generated application entrypoint')
  const executable = join(application, 'Contents/MacOS', name)
  if (!(await lstat(executable)).isFile()) throw new Error('Missing native app executable')
  return { application, executable }
}
/** Real framework commands only; a missing installation is a setup failure. */
export async function desktopEditTrial(
  name: DesktopAdapterName,
  output: string,
  signal?: AbortSignal,
  idleObservationMs?: number
): Promise<DesktopEditTrial> {
  if (!Object.hasOwn(DESKTOP_ADAPTERS, name)) throw new Error('Unknown desktop adapter')
  const identity = DESKTOP_ADAPTERS[name],
    commands: CommandRecord[] = []
  const parent = join(root, '.bunly/desktop-edit-fixtures')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await mkdir(output, { recursive: true })
  const project = await mkdtemp(join(parent, name + '-'))
  let result: DesktopEditResult | null = null,
    setupFailure: string | null = null,
    retainedFixture: string | null = null
  let engineIdentity: CefIdentity | null = null
  let application: string | undefined,
    executable = ''
  const unavailable = (
    category: 'installed' | 'installer' | 'first-run-download' | 'cache' | 'update'
  ) =>
    unavailableBytes(
      category,
      'This desktop edit workflow did not measure this distribution category'
    )
  let bytes: readonly ByteObservation[] = [
    'installed',
    'installer',
    'first-run-download',
    'cache',
    'update',
  ].map((v) => unavailable(v as Parameters<typeof unavailable>[0]))
  try {
    const state = { token: randomBytes(24).toString('hex'), counter: 17 }
    const invalidRevisionMarker =
      name === 'electrobun'
        ? 'BUNLY_INVALID_REVISION_' + randomBytes(12).toString('hex')
        : undefined
    const statePath = join(project, 'fixture-state.json')
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
    const src = join(project, 'src')
    await mkdir(src)
    for (const file of ['host.ts', `${name}.ts`, 'preload.cjs'])
      await copyFile(join(templates, file + '.txt'), join(src, file))
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ name: 'bunly-private-edit-fixture', private: true, type: 'module' })
    )
    const command = (
      phase: string,
      args: readonly string[],
      env: Record<string, string | undefined> = {},
      redact: readonly string[] = [],
      cwd = project,
      timeoutMs = 30000
    ) => {
      const report = join(output, `${String(commands.length).padStart(3, '0')}-${phase}.json`)
      // Reserve an ordinal immediately so no two concurrently finishing commands share a path.
      const index = commands.length
      commands.push({ phase, report: basename(report), observation: null })
      const child = observedCommand(args, {
        cwd,
        output: report,
        timeoutMs,
        env,
        redact,
        ...(signal ? { signal } : {}),
      })
      const observed = child.result.then((observation) => {
        commands[index] = { phase, report: basename(report), observation }
        return observation
      })
      void observed.catch(() => {})
      return { result: observed, path: child.path }
    }
    let build: () => Promise<CommandObservation>
    if (name === 'electron') {
      const manifest = join(root, 'benchmarks/adapters/electron/package.json')
      const require = createRequire(manifest)
      const installed = require('electron/package.json') as { version?: string }
      if (installed.version !== identity.version)
        throw new Error('Install the pinned Electron baseline before running the edit driver')
      executable = await realpath(require('electron') as string)
      if (!(await lstat(executable)).isFile()) throw new Error('Electron binary is missing')
      await mkdir(join(project, 'dist'))
      await copyFile(join(src, 'preload.cjs'), join(project, 'dist/preload.cjs'))
      build = async () =>
        await command('build', [
          process.execPath,
          'build',
          join(src, 'electron.ts'),
          '--target=node',
          '--format=cjs',
          '--external',
          'electron',
          '--outfile',
          join(project, 'dist/main.cjs'),
        ]).result
    } else {
      if (process.platform !== 'darwin' || process.arch !== 'arm64')
        throw new Error(
          'Electrobun edit layout is currently qualified for macOS arm64 only; no platform substitution'
        )
      const bootstrap = join(
        root,
        'benchmarks/adapters/electrobun/node_modules/electrobun/bin/electrobun.cjs'
      )
      const installed = JSON.parse(
        await readFile(join(bootstrap, '../../package.json'), 'utf8')
      ) as { version?: string }
      if (installed.version !== identity.version)
        throw new Error('Electrobun bootstrap pin mismatch')
      const namespace = randomBytes(8).toString('hex')
      let config = await readFile(
        join(root, 'benchmarks/adapters/electrobun/template/electrobun.config.ts.txt'),
        'utf8'
      )
      config = config
        .replace('BunlyBaseline', 'BunlyEdit' + namespace)
        .replace('dev.bunly.benchmark.electrobun', 'dev.bunly.benchmark.edit' + namespace)
        .replace('src/main.ts', 'src/electrobun.ts')
      await writeFile(join(project, 'electrobun.config.ts'), config)
      await copyFile(
        join(root, 'benchmarks/adapters/electrobun/template/hutch.config.ts.txt'),
        join(project, 'hutch.config.ts')
      )
      const environment = { HUTCH_HOME: join(root, '.bunly/benchmarks/hutch-home') }
      for (const args of [['prepare'], ['config', '--env=dev']])
        assertCleanCommand(
          await command(
            args[0]!,
            [process.execPath, bootstrap, ...args],
            environment,
            [],
            project,
            240000
          ).result
        )
      build = async () => {
        const observation = await command(
          'build',
          [process.execPath, bootstrap, 'build', '--env=dev'],
          environment,
          [],
          project,
          240000
        ).result
        if (observation.exitCode === 0 && !observation.timedOut) {
          const layout = await macApplication(project)
          application = layout.application
          executable = layout.executable
        }
        return observation
      }
    }
    const adapter: DesktopEditAdapter = {
      workbenchAssets: await loadWorkbenchAssets(),
      ...(invalidRevisionMarker ? { invalidRevisionMarker } : {}),
      kind: 'desktop',
      artifactKind: name === 'electrobun' ? 'application-directory' : 'main-bundle',
      framework: identity.framework,
      version: identity.version,
      state,
      html: await readFile(join(templates, 'index.html'), 'utf8'),
      javascript: await readFile(join(templates, 'client.js'), 'utf8'),
      async writeRevision(revision) {
        await writeFile(
          join(src, 'revision.ts'),
          revision === 'broken'
            ? invalidRevisionMarker
              ? `export const revision = 'broken' ${invalidRevisionMarker};\n`
              : 'export const revision = ;\n'
            : `export const revision = '${revision}';\n`
        )
      },
      async verifyState() {
        const actual = JSON.parse(await readFile(statePath, 'utf8'))
        if (JSON.stringify(actual) !== JSON.stringify(state))
          throw new Error('Fixture-owned state was changed')
      },
      build,
      async launch(config: DesktopLaunch) {
        const env = {
          BUNLY_EDIT_ORIGIN: config.origin,
          BUNLY_EDIT_LAUNCH: config.launch,
          BUNLY_EDIT_HOST_TOKEN: config.hostToken,
          BUNLY_EDIT_RENDERER_TOKEN: config.rendererToken,
          BUNLY_EDIT_FRAME_ORIGIN: config.workbenchOrigin,
          BUNLY_EDIT_STATE: statePath,
          BUNLY_EDIT_PROFILE: join(project, 'profile'),
        }
        const args =
          name === 'electron' ? [executable, join(project, 'dist/main.cjs')] : [executable]
        return command(
          'app',
          args,
          env,
          [config.hostToken, config.rendererToken],
          name === 'electron' ? project : dirname(executable),
          35000
        )
      },
    }
    result = await runDesktopEdits(adapter, {
      ...(signal ? { signal } : {}),
      ...(idleObservationMs === undefined ? {} : { idleObservationMs }),
    })
    if (application) {
      const installed = await directoryBytes(
        'installed',
        application,
        'Actual generated Electrobun application directory after the final build; logical file bytes, not RAM'
      )
      bytes = bytes.map((row) => (row.category === 'installed' ? installed : row))
      const library = await realpath(
        join(
          application,
          'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
        )
      )
      const binary = await fileBytes(
        'installed',
        library,
        'Hash-pin the actual packaged CEF library'
      )
      engineIdentity = cefIdentityFromObservation(
        await command('cef-identity', [
          process.env['PYTHON'] ?? 'python3',
          join(root, 'scripts/probe_cef_identity.py'),
          '--library',
          library,
          '--sha256',
          binary.sha256!,
        ]).result,
        binary.sha256!
      )
    }
    validateByteMatrix(bytes)
  } catch (error) {
    setupFailure =
      error instanceof Error ? error.message.slice(0, 4096) : 'Desktop edit driver failed'
  } finally {
    // A missing observation is not proof that an owner or its descendants died.
    // Preserve the fixture rather than delete files underneath unconfirmed work.
    if (!observationsPermitFixtureRemoval(commands.map((row) => row.observation))) {
      retainedFixture = relative(root, project)
      setupFailure = [setupFailure, 'Process cleanup was not established; private fixture retained']
        .filter(Boolean)
        .join('; ')
    } else {
      await rm(project, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(
        () => {
          retainedFixture = relative(root, project)
          setupFailure = [setupFailure, 'Private fixture cleanup failed'].filter(Boolean).join('; ')
        }
      )
    }
  }
  return {
    engineIdentity,
    adapter: name,
    passed: setupFailure === null && result?.passed === true,
    result,
    setupFailure,
    retainedFixture,
    commands,
    bytes,
    stages: desktopEditStages(result, setupFailure),
  }
}
