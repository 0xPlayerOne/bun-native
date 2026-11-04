import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'

async function fingerprints(paths: readonly string[]) {
  return Promise.all(
    paths.map(async (path) => {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      return { path, bytes: (await stat(path)).size, sha256: hash.digest('hex') }
    })
  )
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Observe the unmodified template hooks; never request a successful test's closure. */
export async function observeTemplate(
  command: string[],
  environment: Record<string, string | undefined>,
  artifacts: readonly string[],
  timeoutMs = 35_000
) {
  if (command.length === 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 35_000)
    throw new Error('A command and a timeout between 1 and 35000 milliseconds are required')
  const before = await fingerprints(artifacts)
  const started = performance.now()
  const disconnected = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  let ipcDisconnected = false
  let readyCount = 0
  let stoppedCount = 0
  let readyMs: number | undefined
  let stoppedMs: number | undefined
  let stopped: Record<string, unknown> | undefined
  let error: string | undefined
  let forced = false
  const child = Bun.spawn(command, {
    // Both the module and the packaged executable must resolve without the
    // generated project or repository as the process's working directory.
    cwd: tmpdir(),
    env: environment,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    ipc(message: unknown) {
      const value = record(message)
      if (value?.['type'] === 'bun-native:ready') {
        readyCount++
        readyMs ??= performance.now() - started
        if (readyCount !== 1 || stoppedCount !== 0) error ??= 'Out-of-order readiness'
      } else if (value?.['type'] === 'bun-native:stopped') {
        stoppedCount++
        stoppedMs ??= performance.now() - started
        stopped = value
        if (readyCount !== 1 || stoppedCount !== 1) error ??= 'Out-of-order shutdown'
      } else error ??= 'Unexpected template IPC record'
    },
    onDisconnect() {
      ipcDisconnected = true
      disconnected.resolve()
    },
  })
  const joined = Promise.all([child.exited, disconnected.promise])
  const cancel = () => {
    error ??= 'Template owner was interrupted'
    cancelled.resolve()
  }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  const deadline = setTimeout(() => {
    error ??= 'Template did not exit and disconnect within its deadline'
    cancelled.resolve()
  }, timeoutMs)
  let killDeadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([joined, cancelled.promise])
    if (error) {
      if (child.exitCode === null) {
        forced = true
        child.kill('SIGTERM')
      }
      killDeadline = setTimeout(() => {
        if (child.exitCode === null) {
          forced = true
          child.kill('SIGKILL')
        }
        // A failed child could leave an inherited IPC descriptor in another
        // process. End that channel only on the already-failed cleanup path;
        // normal qualification always waits for the child's own disconnect.
        if (!ipcDisconnected) {
          forced = true
          child.disconnect()
        }
      }, 1_000)
    }
    // The outer X11 driver also owns this entire process group and has its own
    // bounded kill/reap path. This owner joins the app and drains its IPC pipe.
    await joined
  } finally {
    clearTimeout(deadline)
    clearTimeout(killDeadline)
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
  const application = record(stopped?.['application'])
  const keys = [
    'windows',
    'nodes',
    'callbacks',
    'queuedTransactions',
    'queuedCallbacks',
    'activeCallbacks',
    'serviceRequests',
  ]
  const zeroResources =
    stopped?.['nodes'] === 0 &&
    application !== undefined &&
    keys.every((key) => application[key] === 0)
  const after = await fingerprints(artifacts)
  if (JSON.stringify(before) !== JSON.stringify(after))
    error ??= 'Template artifacts changed during execution'
  if (readyCount !== 1 || stoppedCount !== 1 || !zeroResources || child.exitCode !== 0)
    error ??= 'Template did not report exactly one ready/zero-resource stop and exit successfully'
  return {
    schema_version: 1,
    status: error ? 'failed' : 'passed',
    verification_scope:
      'Template IPC lifecycle and joined process exit; native input and paint are checked by the X11 driver',
    command,
    cwd: tmpdir(),
    bun_revision: Bun.revision,
    pid: child.pid,
    exit_code: child.exitCode,
    signal: child.signalCode,
    ready_count: readyCount,
    stopped_count: stoppedCount,
    ready_ms: readyMs,
    stopped_ms: stoppedMs,
    elapsed_ms: performance.now() - started,
    zero_resources: zeroResources,
    final_resources: stopped,
    ipc_disconnected: ipcDisconnected,
    process_joined: true,
    forced_termination: forced,
    artifacts: before,
    artifacts_unchanged: JSON.stringify(before) === JSON.stringify(after),
    ...(error ? { error } : {}),
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: true,
    options: { report: { type: 'string' }, artifact: { type: 'string', multiple: true } },
  })
  if (!values.report) throw new Error('--report is required')
  const report = await observeTemplate(positionals, process.env, values.artifact ?? [])
  await writeFile(values.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  process.exitCode = report.status === 'passed' ? 0 : 1
}
