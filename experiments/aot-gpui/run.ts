import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { arch, release, platform, cpus } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { inspectBunExecutable } from './inspect'
import { inspectBunRuntime } from './inspect-runtime'

const destination = process.argv[2]
if (!destination || !isAbsolute(destination)) {
  throw new Error('Usage: bun experiments/aot-gpui/run.ts <absolute-output-directory>')
}
mkdirSync(destination, { recursive: true })
const outputDirectory = destination
const manifest = await Bun.file(new URL('../../toolchain.json', import.meta.url)).json()
if (Bun.revision !== manifest.bun.revision) throw new Error('Run with the pinned Bun compiler')
const versionFile = await Bun.file(new URL('../../.bun-version', import.meta.url)).text()
if (versionFile.trim() !== manifest.bun.version) throw new Error('Bun version files disagree')
const root = import.meta.dir
const executableSuffix = process.platform === 'win32' ? '.exe' : ''
const librarySuffix =
  process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so'
const library = join(destination, `native${librarySuffix}`)
const native = join(destination, `native-echo${executableSuffix}`)
const aot = join(destination, `probe-aot${executableSuffix}`)
const jit = join(destination, `probe-jit${executableSuffix}`)
const compiler = process.env.CC ?? (process.platform === 'win32' ? 'clang' : 'cc')
const results: {
  name: string
  command: string[]
  cwd: string
  exitCode: number
  durationMs: number
}[] = []

function run(name: string, command: string[], expected = 0, cwd = root): string {
  const start = performance.now()
  const result = Bun.spawnSync(command, {
    cwd,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env['PATH'] ?? ''}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  writeFileSync(join(outputDirectory, `${name}.stdout.log`), stdout)
  writeFileSync(join(outputDirectory, `${name}.stderr.log`), stderr)
  results.push({
    name,
    command,
    cwd,
    exitCode: result.exitCode,
    durationMs: performance.now() - start,
  })
  if (result.exitCode !== expected) {
    throw new Error(
      `${name}: expected exit ${expected}, got ${result.exitCode}\n${stdout}\n${stderr}`
    )
  }
  return stdout
}

run('bun-revision', [process.execPath, '--revision'])
run('aot-help', [process.execPath, 'compile', '--no-script', '--help'])
run('cc-version', [compiler, '--version'])
const rust = run('rustc-version', ['rustc', '--version'])
if (!rust.startsWith(`rustc ${manifest.rust.version} `)) throw new Error('Rust version mismatch')
const libraryFlags = process.platform === 'darwin' ? ['-dynamiclib'] : ['-shared']
const positionIndependent = process.platform === 'win32' ? [] : ['-fPIC']
run('build-library', [
  compiler,
  '-Wall',
  '-Wextra',
  '-Werror',
  '-O2',
  ...libraryFlags,
  ...positionIndependent,
  join(root, 'native.c'),
  '-o',
  library,
])
run('build-native-echo', [
  compiler,
  '-Wall',
  '-Wextra',
  '-Werror',
  '-O2',
  '-DBUN_NATIVE_EXECUTABLE',
  join(root, 'native.c'),
  '-o',
  native,
])
run('typecheck', [process.execPath, 'check', '--no-script', '-p', join(root, 'tsconfig.json')])
run('inspector-tests', [
  process.execPath,
  'test',
  join(root, 'inspect.test.ts'),
  join(root, 'inspect-runtime.test.ts'),
  join(root, 'inspect-runtime-formats.test.ts'),
])
const dev = run('dev', [process.execPath, join(root, 'probe.ts'), library, native, 'dev'])
const scriptControl = join(destination, 'package-script-control')
mkdirSync(scriptControl)
writeFileSync(
  join(scriptControl, 'package.json'),
  JSON.stringify({ private: true, scripts: { compile: 'bun sentinel.cjs' } })
)
writeFileSync(
  join(scriptControl, 'sentinel.cjs'),
  "require('node:fs').writeFileSync('script-ran', 'package script\\n')\n"
)
run('compile-script-control', [process.execPath, 'compile'], 0, scriptControl)
const scriptMarker = join(scriptControl, 'script-ran')
if (readFileSync(scriptMarker, 'utf8') !== 'package script\n') {
  throw new Error('Same-named compile package script did not execute in the control')
}
unlinkSync(scriptMarker)
run(
  'compile-aot',
  [
    process.execPath,
    'compile',
    '--no-script',
    '--production',
    '--explain=json',
    join(root, 'probe.ts'),
    '--outfile',
    aot,
  ],
  0,
  scriptControl
)
if (existsSync(scriptMarker)) throw new Error('AOT compilation ran the package script')
const compiled = run('aot', [aot, library, native, 'aot'])
run('compile-jit-control', [
  process.execPath,
  'compile',
  '--no-script',
  '--no-aot',
  join(root, 'probe.ts'),
  '--outfile',
  jit,
])
run('jit-control', [jit, library, native, 'dev'])
const aotMetadata = inspectBunExecutable(aot)
const jitMetadata = inspectBunExecutable(jit)
if (!aotMetadata.hasCompiledProgram || jitMetadata.hasCompiledProgram) {
  throw new Error('Bun executable metadata does not distinguish AOT from the JIT control')
}
const runtimeFeatures = { aot: inspectBunRuntime(aot), jit: inspectBunRuntime(jit) }
if (
  runtimeFeatures.aot.jit === 'present' ||
  runtimeFeatures.aot.jitRemovedRanges.count === 0 ||
  runtimeFeatures.jit.jit !== 'present'
)
  throw new Error('Runtime feature metadata does not distinguish JIT removal from the JIT control')
run('missing-library', [aot, join(destination, 'does-not-exist' + librarySuffix), native, 'aot'], 1)

const wrongType = join(destination, 'wrong-type.ts')
writeFileSync(wrongType, 'const answer: number = "wrong"; console.log(answer);\n')
const rejectedOutput = join(destination, 'must-not-exist')
if (existsSync(rejectedOutput))
  throw new Error('Negative-test output already exists; use a clean output directory')
run(
  'negative-typecheck',
  [process.execPath, 'compile', '--no-script', wrongType, '--outfile', rejectedOutput],
  1,
  scriptControl
)
if (existsSync(rejectedOutput)) throw new Error('Compiler emitted an executable for invalid types')
if (existsSync(scriptMarker)) throw new Error('Invalid-source compilation ran the package script')

let binaryInspection = 'unsupported'
if (process.platform === 'linux') {
  const sections = run('aot-sections', ['readelf', '-SW', aot])
  if (!sections.includes('.bun_aot')) throw new Error('Compiled ELF lacks its .bun_aot section')
  run('aot-linkage', ['ldd', aot])
  binaryInspection = 'ELF .bun_aot section present; linkage captured'
} else if (process.platform === 'darwin') {
  run('aot-sections', ['otool', '-l', aot])
  run('aot-linkage', ['otool', '-L', aot])
  binaryInspection = 'Mach-O load commands and linkage captured; inspect retained logs'
}

const artifacts = [aot, jit, library, native].map((path) => {
  const bytes = readFileSync(path)
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
})
const report = {
  platform: platform(),
  architecture: arch(),
  osRelease: release(),
  cpu: cpus()[0]?.model ?? 'unknown',
  logicalCpus: cpus().length,
  bun: manifest.bun.cliRevision,
  bunRevision: Bun.revision,
  rust,
  gpuiRevision: manifest.gpui.revision,
  sourceHashes: [
    'run.ts',
    'probe.ts',
    'inspect.ts',
    'inspect.test.ts',
    'inspect-runtime.ts',
    'inspect-runtime.test.ts',
    'inspect-runtime-formats.test.ts',
    'native.c',
    'tsconfig.json',
  ].map((name) => ({
    name,
    sha256: createHash('sha256')
      .update(readFileSync(join(root, name)))
      .digest('hex'),
  })),
  dev: JSON.parse(dev),
  aot: JSON.parse(compiled),
  binaryInspection,
  aotMetadata,
  jitMetadata,
  runtimeFeatures,
  artifacts,
  results,
  scope:
    'Headless compiler/native interop probe. Does not verify GPUI rendering, OS input, threading or platform support.',
}
writeFileSync(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
