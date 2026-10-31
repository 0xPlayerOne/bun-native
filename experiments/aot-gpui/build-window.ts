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
import { inspectBunExecutable } from './inspect'
import { inspectBunRuntime } from './inspect-runtime'
import toolchain from '../../toolchain.json'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    host: { type: 'string' },
    outdir: { type: 'string' },
    source: { type: 'string' },
    'host-profile': { type: 'string' },
    trim: { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
})
if (!values.host || !values.outdir || !isAbsolute(values.host) || !isAbsolute(values.outdir)) {
  throw new Error(
    'Usage: bun experiments/aot-gpui/build-window.ts --host <absolute-native-host> --outdir <absolute-empty-directory> [--source <repository>]'
  )
}
if (Bun.revision !== toolchain.bun.revision) throw new Error('Use the pinned Bun AOT compiler')
if (!statSync(values.host).isFile()) throw new Error('The prebuilt native host must be a file')
const outdir = values.outdir
const hostProfile = values['host-profile'] ?? 'unverified'
if (!['dev', 'release', 'unverified'].includes(hostProfile)) {
  throw new Error('--host-profile must be dev or release when supplied')
}
if (existsSync(outdir) && readdirSync(outdir).length > 0)
  throw new Error('Output directory must be empty')
const source = resolve(values.source ?? fileURLToPath(new URL('../..', import.meta.url)))
const entrypoint = join(source, 'examples/native-window/main.ts')
if (!existsSync(entrypoint))
  throw new Error('Native window fixture not found in the source repository')
const version = (await Bun.file(join(source, '.bun-version')).text()).trim()
if (version !== toolchain.bun.version) throw new Error('Source repository Bun pin does not match')
const suffix = process.platform === 'win32' ? '.exe' : ''
const application = join(outdir, `native-window${suffix}`)
const host = join(outdir, `bun-native-host${suffix}`)
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

const sourceCommit = command('source-revision', ['git', 'rev-parse', 'HEAD'])
const sourceChanges = command('source-status', ['git', 'status', '--porcelain'])
const compileCommand = [
  process.execPath,
  'compile',
  '--no-script',
  '--production',
  ...(values.trim ? ['--trim'] : []),
  '--explain=json',
  entrypoint,
  '--outfile',
  application,
]
const start = performance.now()
command('compile-aot', compileCommand)
const buildMs = performance.now() - start
const inspection = inspectBunExecutable(application)
if (!inspection.hasCompiledProgram)
  throw new Error('Compiler output has no compiled-program record')
const runtimeFeatures = process.platform === 'linux' ? inspectBunRuntime(application) : null
if (
  runtimeFeatures &&
  (runtimeFeatures.jit === 'present' || runtimeFeatures.jitRemovedRanges.count === 0)
)
  throw new Error('Compiler output does not record removal of the JIT compiler')
copyFileSync(values.host, host)
if (process.platform !== 'win32') chmodSync(host, 0o755)

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

async function artifact(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { bytes: statSync(path).size, sha256: hash.digest('hex') }
}

const sources = [
  'examples/native-window/main.ts',
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig.json',
  'packages/protocol/package.json',
  'packages/runtime/package.json',
  '.bun-version',
  'rust-toolchain.toml',
  'toolchain.json',
  'Cargo.toml',
  'Cargo.lock',
  'native/gpui-host/Cargo.toml',
  'native/protocol/Cargo.toml',
]
for await (const path of new Bun.Glob('packages/{protocol,runtime}/src/**/*.ts').scan({
  cwd: source,
}))
  sources.push(path)
for await (const path of new Bun.Glob('native/{gpui-host,protocol}/src/**/*.rs').scan({
  cwd: source,
}))
  sources.push(path)
const sourceHashes = await Promise.all(
  sources.sort().map(async (path) => ({ path, ...(await artifact(join(source, path))) }))
)
const manifest = {
  schemaVersion: 1,
  application: {
    file: `native-window${suffix}`,
    ...(await artifact(application)),
    inspection,
    runtimeFeatures,
  },
  host: {
    file: `bun-native-host${suffix}`,
    profile: hostProfile,
    ...(await artifact(host)),
    provenance:
      'Caller-supplied prebuilt host. Match this hash to native build and interaction evidence.',
  },
  toolchain,
  target: { os: platform(), architecture: arch(), osRelease: release() },
  source: { commit: sourceCommit, dirty: sourceChanges !== '', files: sourceHashes },
  compileCommand,
  buildMs,
  launch: {
    executable: `native-window${suffix}`,
    environment: { BUN_NATIVE_HOST: '<absolute-output-directory>/bun-native-host' + suffix },
  },
  verification: {
    aotCompiledProgram: 'passed',
    jitOmission: runtimeFeatures ? 'passed' : 'not-implemented-for-this-format',
    nativeRendering: 'not-run',
    osInput: 'not-run',
    teardown: 'not-run',
    installation: 'not-tested',
    signing: 'unsigned',
  },
}
writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))
