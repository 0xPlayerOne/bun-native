import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cargoEnvironment } from './cargo-config.ts'
const root = resolve(import.meta.dir, '..')
const target = `${process.platform}-${process.arch}`
const directory = join(root, '.bunly/qualification')
const native = join(cargoEnvironment([], process.env).targetDir, 'release')
await mkdir(directory, { recursive: true })
const library =
  process.platform === 'win32'
    ? 'bunly_host_probe.dll'
    : process.platform === 'darwin'
      ? 'libbunly_host_probe.dylib'
      : 'libbunly_host_probe.so'
const addon = join(directory, 'kernel-probe.node')
await copyFile(join(native, library), addon)
const results: Record<string, unknown>[] = []
for (const mode of ['ffi', 'napi', 'process'] as const) {
  const path = join(directory, `kernel-${target}-${mode}.json`)
  const command =
    mode === 'process'
      ? [
          join(native, 'process-soak' + (process.platform === 'win32' ? '.exe' : '')),
          process.execPath,
          join(root, 'scripts/probes/process-generation.ts'),
        ]
      : [process.execPath, join(root, 'scripts/probes/recreate.ts'), mode, addon, 'normal']
  const child = Bun.spawn(
    [
      process.env['PYTHON'] ?? 'python',
      join(root, 'scripts/observe-kernel.py'),
      '--output',
      path,
      '--timeout',
      '40',
      ...(process.platform === 'darwin' ? ['--require-counters'] : []),
      '--',
      ...command,
    ],
    { stdout: 'inherit', stderr: 'inherit' }
  )
  const exitCode = await child.exited
  const report = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const reports = report['reports'] as Record<string, unknown>[]
  const passed = exitCode === 0 && report['exitCode'] === 0 && reports.at(-1)?.['passed'] === true
  results.push({ mode, passed, measurements: report['kernelMeasurements'] })
}
const report = {
  schema: 1,
  target,
  bun: Bun.version,
  sourceCommit: process.env['GITHUB_SHA'] ?? 'local',
  scope: 'OS-specific kernel counters for ABI probes; not GUI power or cross-platform performance',
  results,
  limitations: [
    'Windows ETW integration remains unavailable.',
    'Linux needs enabled kernel schedstats; unavailable is not a zero.',
    'Darwin package/interrupt wakeups differ from Linux scheduler wakeups.',
    'New/exited task intervals and observer overhead limit conclusions.',
  ],
}
await writeFile(
  join(directory, `kernel-summary-${target}.json`),
  JSON.stringify(report, null, 2) + '\n'
)
if (results.some((result) => !result['passed']))
  throw new Error('Kernel-instrumented host qualification failed')
