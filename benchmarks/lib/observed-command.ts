/** Runs trusted local commands through the existing process-tree observer. */
import { randomBytes } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
export interface CommandObservation {
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
  readonly samples: readonly { readonly processes: readonly { readonly pid: number }[] }[]
  readonly environment: Readonly<Record<string, unknown>>
}
export interface ObservedCommand {
  /** Always await this before deleting a fixture or starting its next generation. */
  readonly result: Promise<CommandObservation>
  readonly path: string
}
export function validateCommandObservation(input: unknown): CommandObservation {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Missing process observation')
  const v = input as Record<string, unknown>
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
  return input as CommandObservation
}
export function assertCleanCommand(value: CommandObservation, expectedExit = 0): void {
  if (
    value.timedOut ||
    value.cancelled ||
    value.outputOverflow ||
    value.observedOrphans.length ||
    value.cleanupSurvivors.length
  )
    throw new Error('Command timeout, output overflow, or surviving descendant')
  if (value.exitCode !== expectedExit) throw new Error('Unexpected command exit: ' + value.exitCode)
}
/** Unknown exit/cleanup must retain the fixture instead of deleting beneath it. */
export function observationsPermitFixtureRemoval(
  values: readonly (CommandObservation | null)[]
): boolean {
  return values.every((value) => value !== null && value.cleanupSurvivors.length === 0)
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
  const child = Bun.spawn(
    [
      ...interpreter,
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
      !report.cleanupSurvivors.length
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
