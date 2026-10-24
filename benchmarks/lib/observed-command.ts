/** Runs trusted local commands through the existing process-tree observer. */
import { randomBytes } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import nativeDiagnosticEvents from './native-diagnostic-events.json'
export interface CommandObservation {
  readonly postExitCleanup?: {
    readonly schema: 1
    readonly profile: 'macos-verified-code-sign-clone-v1'
    readonly passed: boolean
    readonly qualified: boolean
    readonly status: 'not-observed' | 'completed' | 'failed'
    readonly elapsedMs: number
    readonly limitMs: 3000
    readonly cloneInventory: {
      readonly prelaunchEntries: number
      readonly entryLimit: 256
      readonly scope: 'new-names-after-prelaunch-snapshot'
    }
  }
  readonly observationId?: string
  readonly exitCode: number
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly cleanupSurvivors: readonly number[]
  readonly outputOverflow: boolean
  readonly observedOrphans: readonly number[]
  readonly elapsedMs: number
  readonly peakTreeRssBytes: number
  readonly peakTreeThreads: number
  readonly stdoutTail: readonly string[]
  readonly stderr: readonly string[]
  /** Whole-run allowlisted native stderr receipts, separately bounded from log tails. */
  readonly nativeDiagnostics?: readonly string[]
  readonly samples: readonly { readonly processes: readonly { readonly pid: number }[] }[]
  readonly environment: Readonly<Record<string, unknown>>
}
export interface ObservedCommand {
  /** Always await this before deleting a fixture or starting its next generation. */
  readonly result: Promise<CommandObservation>
  readonly path: string
}
const nativeDiagnosticNames = new Set<string>(nativeDiagnosticEvents)
/** Retained receipts are authoritative when present. Never replace a missing
 * event with a tail fragment or deduplicate a malformed repeated receipt.
 */
export function nativeDiagnosticLines(
  observation: Pick<CommandObservation, 'stderr' | 'nativeDiagnostics'>
): readonly string[] {
  const records: unknown = observation.nativeDiagnostics
  if (records === undefined) return observation.stderr
  if (!Array.isArray(records) || records.length > 128)
    throw new Error('Invalid retained native diagnostics')
  let bytes = 0
  for (const line of records) {
    if (typeof line !== 'string' || line.length > 16 * 1024)
      throw new Error('Invalid native diagnostic line')
    const size = new TextEncoder().encode(line).byteLength
    bytes += size
    if (size > 16 * 1024 || bytes > 64 * 1024)
      throw new Error('Native diagnostic byte budget exceeded')
    const event: unknown = JSON.parse(line)
    if (
      !event ||
      typeof event !== 'object' ||
      Array.isArray(event) ||
      typeof (event as Record<string, unknown>)['event'] !== 'string' ||
      !nativeDiagnosticNames.has((event as Record<string, unknown>)['event'] as string)
    )
      throw new Error('Unknown retained native diagnostic event')
  }
  return records as string[]
}

export function validateCommandObservation(input: unknown): CommandObservation {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Missing process observation')
  const v = input as Record<string, unknown>
  if (Object.hasOwn(v, 'observationExport'))
    throw new Error('Sanitized evidence requires the exported-observation validator')
  if (
    v['schema'] !== 1 ||
    !Number.isSafeInteger(v['exitCode']) ||
    typeof v['timedOut'] !== 'boolean' ||
    typeof v['outputOverflow'] !== 'boolean' ||
    typeof v['cancelled'] !== 'boolean'
  )
    throw new Error('Invalid process outcome')
  if (
    v['observationId'] !== undefined &&
    (typeof v['observationId'] !== 'string' || !/^[a-f0-9]{48}$/.test(v['observationId']))
  )
    throw new Error('Invalid observation identity')
  for (const name of ['elapsedMs', 'peakTreeRssBytes', 'peakTreeThreads']) {
    if (typeof v[name] !== 'number' || !Number.isFinite(v[name]) || Number(v[name]) < 0)
      throw new Error('Invalid observed resource value')
  }
  if (
    !Array.isArray(v['observedOrphans']) ||
    v['observedOrphans'].some((x) => !Number.isSafeInteger(x) || x < 1)
  )
    throw new Error('Missing descendant accounting')
  if (
    !Array.isArray(v['cleanupSurvivors']) ||
    v['cleanupSurvivors'].some((x) => !Number.isSafeInteger(x) || x < 1)
  )
    throw new Error('Missing post-cleanup accounting')
  for (const name of ['stdoutTail', 'stderr']) {
    if (
      !Array.isArray(v[name]) ||
      v[name].length > 40 ||
      v[name].some((x) => typeof x !== 'string' || x.length > 2 * 1024 * 1024)
    )
      throw new Error('Invalid bounded command diagnostics')
  }
  nativeDiagnosticLines(input as CommandObservation)
  if (!Array.isArray(v['samples']) || v['samples'].length > 4000)
    throw new Error('Invalid process samples')
  for (const sample of v['samples']) {
    if (
      !sample ||
      typeof sample !== 'object' ||
      !Array.isArray(sample.processes) ||
      sample.processes.some(
        (p: { pid?: unknown }) => !p || !Number.isSafeInteger(p.pid) || Number(p.pid) < 1
      )
    )
      throw new Error('Invalid sampled process identity')
  }
  if (!v['environment'] || typeof v['environment'] !== 'object' || Array.isArray(v['environment']))
    throw new Error('Missing observer environment')
  if (v['postExitCleanup'] !== undefined) {
    const cleanup = v['postExitCleanup'] as Record<string, unknown>
    if (
      !cleanup ||
      typeof cleanup !== 'object' ||
      Array.isArray(cleanup) ||
      cleanup['schema'] !== 1 ||
      cleanup['profile'] !== 'macos-verified-code-sign-clone-v1' ||
      typeof cleanup['passed'] !== 'boolean' ||
      typeof cleanup['qualified'] !== 'boolean' ||
      !['not-observed', 'completed', 'failed'].includes(String(cleanup['status'])) ||
      cleanup['limitMs'] !== 3000 ||
      typeof cleanup['elapsedMs'] !== 'number' ||
      !Number.isFinite(cleanup['elapsedMs']) ||
      cleanup['elapsedMs'] < 0
    )
      throw new Error('Invalid post-exit cleanup accounting')
    const helpers = cleanup['helpers']
    if (
      !Number.isSafeInteger(cleanup['observedClones']) ||
      Number(cleanup['observedClones']) < 0 ||
      Number(cleanup['observedClones']) > 256 ||
      !Array.isArray(helpers) ||
      helpers.length > 8
    )
      throw new Error('Invalid cleanup identity bounds')
    const inventory = cleanup['cloneInventory'] as Record<string, unknown>
    if (
      !inventory ||
      typeof inventory !== 'object' ||
      Array.isArray(inventory) ||
      inventory['entryLimit'] !== 256 ||
      inventory['scope'] !== 'new-names-after-prelaunch-snapshot' ||
      !Number.isSafeInteger(inventory['prelaunchEntries']) ||
      Number(inventory['prelaunchEntries']) < 0 ||
      Number(inventory['prelaunchEntries']) > 256
    )
      throw new Error('Invalid prelaunch clone inventory')
    const identities = new Set<string>()
    const kernelIdentities = new Set<string>()
    const recovery = cleanup['recovery'] as Record<string, unknown> | undefined
    if (
      recovery !== undefined &&
      (!recovery ||
        typeof recovery !== 'object' ||
        Array.isArray(recovery) ||
        typeof recovery['attempted'] !== 'boolean' ||
        recovery['candidateLimit'] !== 4096 ||
        recovery['scanLimit'] !== 1 ||
        !Number.isSafeInteger(recovery['candidates']) ||
        Number(recovery['candidates']) < 0 ||
        Number(recovery['candidates']) > 4096 ||
        (!recovery['attempted'] && recovery['candidates'] !== 0))
    )
      throw new Error('Invalid bounded kernel identity recovery')
    for (const input of helpers) {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Invalid cleanup helper identity')
      const helper = input as Record<string, unknown>
      if (
        !Number.isSafeInteger(helper['pid']) ||
        Number(helper['pid']) < 1 ||
        typeof helper['creationTime'] !== 'number' ||
        !Number.isFinite(helper['creationTime']) ||
        helper['creationTime'] < 0 ||
        helper['role'] !== 'code-sign-clone-cleanup' ||
        ![
          'observed-root-child-and-matching-clone-inode',
          'retained-kernel-parent-and-matching-clone-inode',
        ].includes(String(helper['ownership'])) ||
        typeof helper['executableSha256'] !== 'string' ||
        !/^[a-f0-9]{64}$/.test(helper['executableSha256']) ||
        typeof helper['processExited'] !== 'boolean' ||
        typeof helper['cloneRemoved'] !== 'boolean' ||
        typeof helper['completed'] !== 'boolean' ||
        helper['completed'] !== (helper['processExited'] && helper['cloneRemoved']) ||
        (cleanup['passed'] && !helper['completed'])
      )
        throw new Error('Invalid cleanup helper evidence')
      if (helper['ownership'] === 'retained-kernel-parent-and-matching-clone-inode') {
        const kernel = helper['kernelIdentity'] as Record<string, unknown>
        const uniqueId = (value: unknown): value is string =>
          typeof value === 'string' &&
          /^[1-9][0-9]{0,19}$/.test(value) &&
          BigInt(value) <= 18446744073709551615n
        if (
          !kernel ||
          typeof kernel !== 'object' ||
          Array.isArray(kernel) ||
          !uniqueId(kernel['rootUniqueId']) ||
          !uniqueId(kernel['uniqueId']) ||
          !uniqueId(kernel['parentUniqueId']) ||
          kernel['parentUniqueId'] !== kernel['rootUniqueId'] ||
          kernel['uniqueId'] === kernel['rootUniqueId'] ||
          recovery?.['attempted'] !== true
        )
          throw new Error('Invalid retained kernel parent identity')
        if (kernelIdentities.has(kernel['uniqueId']))
          throw new Error('Duplicate retained kernel helper identity')
        kernelIdentities.add(kernel['uniqueId'])
      } else if (helper['kernelIdentity'] !== undefined) {
        throw new Error('Unexpected kernel identity for sampled ancestry')
      }
      const identity = String(helper['pid']) + ':' + helper['creationTime']
      if (identities.has(identity)) throw new Error('Duplicate cleanup helper identity')
      identities.add(identity)
    }
    const qualified =
      cleanup['passed'] && Number(cleanup['observedClones']) > 0 && helpers.length > 0
    if (
      cleanup['qualified'] !== qualified ||
      cleanup['status'] !==
        (qualified ? 'completed' : cleanup['passed'] ? 'not-observed' : 'failed') ||
      (qualified && cleanup['elapsedMs'] > 3000)
    )
      throw new Error('Inconsistent cleanup qualification outcome')
  }
  return input as CommandObservation
}
export function assertCleanCommand(value: CommandObservation, expectedExit = 0): void {
  // Keep simultaneous failures visible. In particular, failed clone cleanup
  // must not hide the native watchdog's nonzero exit behind an alleged timeout.
  // Only bounded, known reasons and counts are emitted; no child output or IDs.
  const reasons: string[] = []
  if (value.exitCode !== expectedExit)
    reasons.push(`unexpected exit ${value.exitCode} (expected ${expectedExit})`)
  if (value.timedOut) reasons.push('observer timed out')
  if (value.cancelled) reasons.push('observation cancelled')
  if (value.outputOverflow) reasons.push('output overflow')
  if (value.observedOrphans.length)
    reasons.push(`observed orphan count ${value.observedOrphans.length}`)
  if (value.cleanupSurvivors.length)
    reasons.push(`cleanup survivor count ${value.cleanupSurvivors.length}`)
  if (value.postExitCleanup?.passed === false) reasons.push('post-exit cleanup failed')
  if (reasons.length) throw new Error('Command failed: ' + reasons.join('; '))
}
/** Unknown exit/cleanup must retain the fixture instead of deleting beneath it. */
export function observationsPermitFixtureRemoval(
  values: readonly (CommandObservation | null)[]
): boolean {
  return values.every(
    (value) =>
      value !== null &&
      value.cleanupSurvivors.length === 0 &&
      value.postExitCleanup?.passed !== false
  )
}
async function boundedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let count = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      count += next.value.byteLength
      if (count > 1024 * 1024) throw new Error('Observer output exceeded bound')
      chunks.push(next.value)
    }
    return new TextDecoder().decode(Buffer.concat(chunks))
  } finally {
    reader.releaseLock()
  }
}
export function observedCommand(
  command: readonly string[],
  options: {
    readonly cwd: string
    readonly output: string
    readonly timeoutMs?: number
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly redact?: readonly string[]
    readonly signal?: AbortSignal
    /** Trusted interpreter invocation, useful for deterministic startup qualification. */
    readonly observerCommand?: readonly string[]
  }
): ObservedCommand {
  if (
    !command.length ||
    command.some((value) => typeof value !== 'string' || !value.length || value.includes('\0'))
  )
    throw new Error('Invalid trusted command')
  const timeoutMs = options.timeoutMs ?? 30000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000)
    throw new Error('Invalid command deadline')
  const secrets = [...(options.redact ?? [])]
  if (secrets.some((secret) => !/^[a-f0-9]{48}$/.test(secret)))
    throw new Error('Invalid redaction credential')
  options.signal?.throwIfAborted()
  const root = resolve(import.meta.dir, '../..'),
    path = resolve(options.output),
    observationId = randomBytes(24).toString('hex')
  const interpreter = options.observerCommand ?? [process.env['PYTHON'] ?? 'python']
  if (
    !interpreter.length ||
    interpreter.length > 16 ||
    interpreter.some(
      (arg) => typeof arg !== 'string' || !arg || arg.includes('\0') || arg.length > 8192
    )
  )
    throw new Error('Invalid observer interpreter')
  // Resolve trusted tooling against the caller, not the environment and working
  // directory deliberately restricted for the observed application. In particular,
  // native qualification uses an empty PATH to prove compiler independence.
  const executable = Bun.which(interpreter[0]!, { cwd: process.cwd() })
  if (!executable) throw new Error('Observer interpreter not found in caller environment')
  const child = Bun.spawn(
    [
      executable,
      ...interpreter.slice(1),
      join(root, 'scripts/observe-process.py'),
      '--output',
      path,
      '--timeout',
      String(timeoutMs / 1000),
      '--observation-id',
      observationId,
      '--control-id',
      observationId,
      '--',
      ...command,
    ],
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  // Buffered pipe input survives interpreter startup and works on Windows, where
  // TerminateProcess cannot provide Python's graceful SIGTERM cleanup semantics.
  let stopRequested = false
  const stop = () => {
    if (stopRequested || child.exitCode !== null) return
    stopRequested = true
    try {
      child.stdin.write('cancel ' + observationId + '\n')
      child.stdin.end()
    } catch {
      /* A missing cancellation/report is a failure, never a cleanup pass. */
    }
  }
  // Last-resort watchdog: an unresponsive observer is not allowed to wait forever.
  // Its missing report makes cleanup unknown and callers retain the fixture.
  const watchdog = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  }, timeoutMs + 15000)
  options.signal?.addEventListener('abort', stop, { once: true })
  if (options.signal?.aborted) stop()
  const outputs = Promise.all([boundedText(child.stdout), boundedText(child.stderr)])
  void outputs.catch(() => {})
  const result = (async () => {
    const exit = await child.exited
    const [stdout, stderr] = await outputs
    const details = await lstat(path).catch(() => undefined)
    if (!details?.isFile() || details.isSymbolicLink() || details.size > 64 * 1024 * 1024)
      throw new Error('Observer did not produce a bounded regular report: ' + stderr.slice(-2000))
    let text = await readFile(path, 'utf8')
    // Remove per-launch tokens before persisting diagnostic artifacts. No token URLs.
    for (const secret of secrets) {
      text = text.replaceAll(secret, '[redacted]')
    }
    await writeFile(path, text, { mode: 0o600 })
    const report = validateCommandObservation(JSON.parse(text))
    if (report.observationId !== observationId)
      throw new Error('Stale or mismatched process observation')
    if (
      exit !== 0 &&
      !report.timedOut &&
      !report.cancelled &&
      !report.outputOverflow &&
      !report.observedOrphans.length &&
      !report.cleanupSurvivors.length &&
      report.postExitCleanup?.passed !== false
    )
      throw new Error('Observer failed independently of its child: ' + stdout.slice(-1000))
    return report
  })().finally(() => {
    clearTimeout(watchdog)
    options.signal?.removeEventListener('abort', stop)
    try {
      child.stdin.end()
    } catch {
      /* Already closed with process exit. */
    }
  })
  void result.catch(() => {})
  return { result, path }
}
