/** Maintained standard-user functional qualification; no shell, CEF or credential store. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { acceptBunPty } from '../benchmarks/pty/acceptance.ts'
import { qualifyBunPty } from '../benchmarks/pty/qualification.ts'

const root = resolve(import.meta.dir, '..')
assert.equal(process.argv.length, 2)
assert.equal(Bun.version, '1.4.3')
if (process.platform === 'win32') {
  const check = Bun.spawnSync([
    process.env['PYTHON'] ?? 'python',
    '-c',
    'import ctypes; raise SystemExit(1 if ctypes.windll.shell32.IsUserAnAdmin() else 0)',
  ])
  assert.equal(check.exitCode, 0, 'PTY qualification requires a Windows standard user')
} else assert.ok(process.getuid?.() !== 0, 'PTY qualification must not run as root')
const before = sourceIdentity(root)
assert.equal(before.clean, true, 'Committed clean source is required for acceptance')
const parent = join(root, '.bunly/m5/pty')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'run-'))
const report: Record<string, unknown> = {
  schema: 1,
  passed: false,
  sourceBefore: before,
  standardUser: true,
}
try {
  Object.assign(report, await qualifyBunPty())
  acceptBunPty(report)
} catch (error) {
  report['passed'] = false
  report['failureType'] = error instanceof Error ? error.name : 'UnknownError'
} finally {
  const after = sourceIdentity(root)
  report['sourceAfter'] = after
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    report['passed'] = false
    report['failureType'] = 'SourceChanged'
  }
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
  // Only the explicit nonsecret report is eligible for upload, never child profiles or broad output.
  const evidence = join(root, '.bunly/pty-evidence')
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'qualification.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
if (report['passed'] !== true) process.exitCode = 1
