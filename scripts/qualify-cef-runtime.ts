import assert from 'node:assert/strict'
import { cp, mkdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { inventory } from '../benchmarks/lib/inventory.ts'
const root = resolve(import.meta.dir, '..')
const output = join(root, '.bunly/cef-bundle')
const manifest = (await Bun.file(join(output, 'bundle.json')).json()) as { path: string }
const application = process.platform === 'darwin' ? manifest.path : dirname(manifest.path)
const executable =
  process.platform === 'darwin' ? join(application, 'Contents/MacOS/bunly_host') : manifest.path
const resources =
  process.platform === 'darwin'
    ? join(application, 'Contents/Resources')
    : join(application, 'resources')
await cp(join(root, 'native/cef-host/resources'), resources, { recursive: true })
const evidence = join(root, '.bunly/cef-evidence')
await mkdir(evidence, { recursive: true })
if (process.platform === 'darwin') {
  for (const args of [
    ['--force', '--deep', '--sign', '-', application],
    ['--verify', '--deep', '--strict', application],
  ]) {
    const process = Bun.spawn(['codesign', ...args], { stdout: 'inherit', stderr: 'inherit' })
    assert.equal(await process.exited, 0, 'Ad hoc CI bundle signing/verification failed')
  }
}
await writeFile(
  join(evidence, 'installed-files.json'),
  JSON.stringify(await inventory(application), null, 2)
)
for (let trial = 0; trial < 3; trial++) {
  const cache = await mkdtemp(join(tmpdir(), 'bunly-cef-profile-'))
  const path = join(evidence, `runtime-${trial}.json`)
  try {
    const child = Bun.spawn(
      [
        process.env['PYTHON'] ?? 'python3',
        join(root, 'scripts/observe-process.py'),
        '--output',
        path,
        '--timeout',
        '40',
        '--',
        executable,
      ],
      { env: { ...process.env, BUNLY_CACHE_DIR: cache }, stdout: 'inherit', stderr: 'inherit' }
    )
    const exit = await child.exited
    const report = JSON.parse(await readFile(path, 'utf8')) as {
      exitCode: number
      timedOut: boolean
      observedOrphans: number[]
      stderr: string[]
    }
    const completed = report.stderr.some((line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        return value['event'] === 'bunly.native.smoke' && value['passed'] === true
      } catch {
        return false
      }
    })
    if (
      exit !== 0 ||
      report.exitCode !== 0 ||
      report.timedOut ||
      report.observedOrphans.length ||
      !completed
    ) {
      console.error(
        JSON.stringify({
          trial,
          completed,
          exitCode: report.exitCode,
          timedOut: report.timedOut,
          observedOrphans: report.observedOrphans,
          stderr: report.stderr,
        })
      )
      throw new Error('Native CEF smoke failed; retain the complete process observation')
    }
    console.log(
      JSON.stringify({
        trial,
        passed: true,
        platform: process.platform,
        scope: 'Actual packaged CEF lifecycle and public-origin resource checks',
      })
    )
  } finally {
    await rm(cache, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  }
}
