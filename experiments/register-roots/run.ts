/** Fixed diagnostic matrix; retaining outcomes never qualifies their failures. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

const args = process.argv.slice(2)
if (args.length !== 4 || process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Expected source, output, library and runtime paths on actual Windows x64')
const [source, output, library, executable] = args.map((value) => resolve(value)) as [
  string,
  string,
  string,
  string,
]
if (Object.keys(process.env).some((name) => name.startsWith('BUN_JSC_')))
  throw new Error('Refuse inherited collector/JIT overrides')
const expectedHead = '2a9516337fe99e3585ff8f55e97c7392fad2f372'
const expectedTree = '39482669d2095b95d3d75a808a188a231937035c'
const expectedRuntime = 'da867c60bf0bcbf9d6d36994f8ca0efa42075115'
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const git = (...values: string[]) =>
  execFileSync('git', values, { cwd: source, encoding: 'utf8', timeout: 15_000 }).trim()
const originalTest = join(source, 'tests/solid/renderer.test.ts')
const originalHash = digest(originalTest)
function guardSource() {
  if (git('rev-parse', 'HEAD') !== expectedHead || git('rev-parse', 'HEAD^{tree}') !== expectedTree)
    throw new Error('Immutable source identity changed')
  if (git('status', '--porcelain') || digest(originalTest) !== originalHash)
    throw new Error('Source changed')
}
const revision = execFileSync(executable, ['--no-script', '--eval', 'console.log(Bun.revision)'], {
  encoding: 'utf8',
  timeout: 15_000,
}).trim()
if (revision !== expectedRuntime) throw new Error('Runtime identity mismatch')
guardSource()
mkdirSync(output)
const plan = {
  sourceCommit: expectedHead,
  sourceTree: expectedTree,
  testSha256: originalHash,
  bunRevision: revision,
  binarySha256: digest(executable),
  dllSha256: digest(library),
  producerSha256: Object.fromEntries(
    readdirSync(import.meta.dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name, digest(join(import.meta.dir, entry.name))])
  ),
  order: ['original', 'dormant', 'capture'],
  attemptsPerVariant: 1,
  scope: 'Research only; required Validation / Gate remains authoritative',
  limits:
    '16 private 256-KiB stack copies plus 28 nonvolatile register words; selected matches only',
  unchanged:
    'Original full source suite, two GC calls, two sleeps, assertions and per-test deadlines',
}
writeFileSync(join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' })
const outcomes: unknown[] = []
for (const variant of plan.order) {
  guardSource()
  const directory = join(output, variant)
  mkdirSync(directory)
  const env = {
    ...process.env,
    PATH: dirname(executable) + ';' + (process.env['PATH'] ?? ''),
    BUN_NATIVE_RETENTION_DIAGNOSTICS_DIR: directory,
    BN_ROOT_CAPTURE_SOURCE: source,
    BN_ROOT_CAPTURE_OUTPUT: directory,
    BN_ROOT_CAPTURE_LIBRARY: library,
    BN_ROOT_CAPTURE_ACTIVE: variant === 'capture' ? '1' : '0',
  }
  const cmd = [executable, 'test', 'tests']
  if (variant !== 'original') cmd.push('--preload', join(import.meta.dir, 'preload.ts'))
  const logFile = join(directory, 'test.log')
  const log = openSync(logFile, 'wx')
  let forced = false
  let killError: unknown
  const child = Bun.spawn({ cmd, cwd: source, env, stdin: 'ignore', stdout: log, stderr: log })
  const deadline = setTimeout(() => {
    forced = true
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        timeout: 10_000,
        stdio: 'pipe',
      })
    } catch (error) {
      killError = error
      child.kill()
    }
  }, 90_000)
  let exitCode: number
  try {
    exitCode = await child.exited
  } finally {
    clearTimeout(deadline)
    closeSync(log)
  }
  const text = readFileSync(logFile, 'utf8')
  const item = {
    variant,
    exitCode,
    forced,
    cleanupFailed: killError !== undefined,
    summary: text
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.includes('(fail)') ||
          /^\s*\d+ (?:pass|fail|expect\(\) calls)\s*$/.test(line) ||
          line.startsWith('Ran ')
      ),
    diagnostics: readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as unknown),
    logSha256: digest(logFile),
  }
  outcomes.push(item)
  writeFileSync(join(output, 'outcomes.json'), JSON.stringify(outcomes, null, 2) + '\n')
  console.log(JSON.stringify(item))
  guardSource()
  if (killError) throw new Error('Owned child cleanup failed; original outcomes were retained')
}
