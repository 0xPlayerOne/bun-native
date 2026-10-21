import { spawn } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dir, '..')
const target = `${process.platform}-${process.arch}`
const lib =
  process.platform === 'win32'
    ? 'bunly_host_probe.dll'
    : process.platform === 'darwin'
      ? 'libbunly_host_probe.dylib'
      : 'libbunly_host_probe.so'
const native = join(root, 'native/target/release')
const dir = join(root, '.bunly/qualification')
await mkdir(dir, { recursive: true })
const addon = join(dir, 'probe.node')
await copyFile(join(native, lib), addon)
async function execute(command: string, args: string[]): Promise<Record<string, unknown>> {
  const started = performance.now()
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const timeout = setTimeout(() => child.kill(), 20_000)
  return await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 1024 * 1024) child.kill()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 1024 * 1024) child.kill()
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`Probe exited ${code}/${signal}: ${stderr}\n${stdout}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>
        resolve({ ...parsed, launchElapsedMs: performance.now() - started })
      } catch (error) {
        reject(error)
      }
    })
  })
}
const results: Record<string, unknown>[] = []
let failed = false
for (const mode of ['ffi', 'napi', 'process'] as const) {
  for (let trial = 0; trial < 5; trial++) {
    try {
      const result =
        mode === 'process'
          ? await execute(
              join(native, 'bunly-host-probe' + (process.platform === 'win32' ? '.exe' : '')),
              [process.execPath, join(root, 'scripts/probes/process-child.ts')]
            )
          : await execute(process.execPath, [join(root, 'scripts/probes/handoff.ts'), mode, addon])
      results.push({ mode, trial, ...result })
    } catch (error) {
      failed = true
      results.push({
        mode,
        trial,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      })
      break
    }
  }
}
const result = {
  schema: 1,
  scope: 'native ABI/thread-handoff primitives only; not a CEF or GUI benchmark',
  bun: process.versions['bun'],
  target,
  commit: process.env['GITHUB_SHA'] ?? 'local-uncommitted',
  results,
}
await writeFile(join(dir, `host-${target}.json`), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
if (failed) process.exitCode = 1
