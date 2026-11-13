import { createHash } from 'node:crypto'
import {
  createReadStream,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { arch, platform, release } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { compileApplication } from '../../scripts/native/compile.ts'
import { bundleApplication, moduleInputs } from '../../scripts/native/bundle.ts'
import {
  fixtureInventory,
  fixtures,
  isFixture,
  unprofiled,
  type Fixture,
} from '../../scripts/quality/native-fixtures.ts'
import toolchain from '../../toolchain.json'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    host: { type: 'string' },
    outdir: { type: 'string' },
    source: { type: 'string' },
    entry: { type: 'string', default: 'native-window' },
    'host-profile': { type: 'string' },
    trim: { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
})
const entry = values.entry
if (!isFixture(entry))
  throw new Error('--entry must be one of: ' + Object.keys(fixtures).join(', '))
const fixture: Fixture = fixtures[entry]
const entryPath = fixture.path
if (!values.host || !values.outdir || !isAbsolute(values.host) || !isAbsolute(values.outdir)) {
  throw new Error(
    'Usage: bun experiments/aot-gpui/build-window.ts --host <absolute-native-host> --outdir <absolute-empty-directory> [--source <repository>] [--entry ' +
      Object.keys(fixtures).join('|') +
      ']'
  )
}
if (Bun.revision !== toolchain.bun.revision) throw new Error('Use the pinned Bun AOT compiler')
if (!statSync(values.host).isFile()) throw new Error('The prebuilt native host must be a file')
const outdir = values.outdir
const hostProfile = values['host-profile'] ?? 'unverified'
if (!['dev', 'release', 'unverified'].includes(hostProfile)) {
  throw new Error('--host-profile must be dev or release when supplied')
}
if (!unprofiled.has(entry) && hostProfile === 'unverified')
  throw new Error('Native benchmarks require --host-profile dev or release')
if (existsSync(outdir) && readdirSync(outdir).length > 0)
  throw new Error('Output directory must be empty')
const source = resolve(values.source ?? fileURLToPath(new URL('../..', import.meta.url)))
const entrypoint = join(source, entryPath)
if (!existsSync(entrypoint)) throw new Error(`Application entry not found: ${entryPath}`)
const version = (await Bun.file(join(source, '.bun-version')).text()).trim()
if (version !== toolchain.bun.version) throw new Error('Source repository Bun pin does not match')
if (
  JSON.stringify(await Bun.file(join(source, 'toolchain.json')).json()) !==
  JSON.stringify(toolchain)
)
  throw new Error('Source repository toolchain pins do not match this build helper')
const suffix = process.platform === 'win32' ? '.exe' : ''
const applicationFile = `${entry}${suffix}`
const application = join(outdir, applicationFile)
const bundledHost = entry === 'native-window'
const hostFile = bundledHost ? `bun-native-host${suffix}` : values.host
const host = bundledHost ? join(outdir, hostFile) : values.host
mkdirSync(outdir, { recursive: true })

function command(name: string, argv: string[]): string {
  const result = Bun.spawnSync(argv, {
    cwd: source,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  })
  writeFileSync(join(outdir, `${name}.stdout.log`), result.stdout)
  writeFileSync(join(outdir, `${name}.stderr.log`), result.stderr)
  if (result.exitCode !== 0)
    throw new Error(`${name} failed (${result.exitCode}): ${result.stderr}`)
  return result.stdout.toString().trim()
}

async function artifact(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { bytes: statSync(path).size, sha256: hash.digest('hex') }
}

const sourceCommit = command('source-revision', ['git', 'rev-parse', 'HEAD'])
const sourceChanges = command('source-status', ['git', 'status', '--porcelain'])
let compileInput = entrypoint
let compileDirectory = source
let developmentModule:
  | { file: string; bytes: number; sha256: string; bundler: string; buildMs: number }
  | undefined
// The module inputs come from the bundler's metafile, so the inventory cannot miss an import.
let modules: string[]
if (fixture.framework) {
  // The same in-process bundler configuration as `native dev` and `native build`.
  const bundleStart = performance.now()
  ;({ inputs: modules } = await bundleApplication({
    framework: fixture.framework,
    entry: entrypoint,
    outdir: join(outdir, 'development'),
    cwd: source,
  }))
  // Compile the module from the output directory, as `native build` compiles its
  // launcher, so the executable does not depend on where that directory is.
  compileInput = 'development/application.js'
  compileDirectory = outdir
  developmentModule = {
    file: compileInput,
    ...(await artifact(join(outdir, compileInput))),
    bundler: 'scripts/native/bundle.ts',
    buildMs: performance.now() - bundleStart,
  }
} else modules = await moduleInputs(entrypoint, source)
const sourceHashes = () => fixtureInventory(source, entry, modules)
const buildSources = await sourceHashes()

const { compileCommand, buildMs, inspection, runtimeFeatures } = compileApplication(
  compileInput,
  application,
  compileDirectory,
  values.trim
)
if (bundledHost) {
  copyFileSync(values.host, host)
  if (process.platform !== 'win32') chmodSync(host, 0o755)
}

const inspectionTool = process.platform === 'darwin' ? 'otool' : 'readelf'
if (process.platform !== 'win32') {
  command('application-sections', [
    inspectionTool,
    process.platform === 'darwin' ? '-l' : '-SW',
    application,
  ])
  command(
    'application-linkage',
    process.platform === 'darwin' ? ['otool', '-L', application] : ['ldd', application]
  )
  command('host-linkage', process.platform === 'darwin' ? ['otool', '-L', host] : ['ldd', host])
}

if (JSON.stringify(buildSources) !== JSON.stringify(await sourceHashes()))
  throw new Error('Application or native source changed during the AOT build')
if (
  developmentModule &&
  (await artifact(join(outdir, developmentModule.file))).sha256 !== developmentModule.sha256
)
  throw new Error('The generated development module changed during AOT compilation')
const launchHost = bundledHost ? '<absolute-output-directory>/bun-native-host' + suffix : host
const manifest = {
  schemaVersion: 1,
  entrypoint: entryPath,
  application: {
    file: applicationFile,
    ...(await artifact(application)),
    inspection,
    runtimeFeatures,
    ...(developmentModule ? { developmentModule } : {}),
  },
  host: {
    file: hostFile,
    placement: bundledHost ? 'bundled' : 'external',
    profile: hostProfile,
    ...(await artifact(host)),
    provenance: bundledHost
      ? 'Caller-supplied prebuilt host copied into this package. Match this hash to native build and interaction evidence.'
      : 'Caller-supplied prebuilt host referenced in place, not bundled. Match this hash to native build and interaction evidence.',
  },
  toolchain,
  target: { os: platform(), architecture: arch(), osRelease: release() },
  source: { commit: sourceCommit, dirty: sourceChanges !== '', files: buildSources },
  compileCommand,
  buildMs,
  launch: {
    executable: applicationFile,
    ...(entry === 'bridge'
      ? {
          arguments: [
            '--host',
            launchHost,
            '--host-profile',
            hostProfile,
            '--mode',
            'aot',
            '--source',
            source,
            '--aot-manifest',
            '<absolute-output-directory>/manifest.json',
            '--output',
            '<absolute-new-trial-directory>',
          ],
        }
      : {
          environment: {
            BUN_NATIVE_HOST: launchHost,
            ...(entry === 'input-race' ? { BUN_NATIVE_EVIDENCE_NONCE: '<fresh-test-nonce>' } : {}),
          },
        }),
  },
  verification: {
    aotCompiledProgram: 'passed',
    jitOmission: 'passed',
    nativeRendering: 'not-run',
    osInput: 'not-run',
    teardown: 'not-run',
    installation: 'not-tested',
    signing: 'unsigned',
  },
}
writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))
