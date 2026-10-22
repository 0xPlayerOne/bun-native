/** Execute trusted, local release plans. A successful command alone is not evidence. */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  BYTE_CATEGORIES,
  directoryBytes,
  fileBytes,
  unavailableBytes,
  validateByteMatrix,
  type ByteCategory,
  type ByteObservation,
} from './accounting.ts'
import { assertCleanCommand, observedCommand, type CommandObservation } from './observed-command.ts'
import {
  transferArtifact,
  transferBytes,
  validateArtifactTransfer,
  type ArtifactTransfer,
  type TransferReport,
} from './artifact-transfer.ts'
import {
  STAGES,
  unsupportedStage,
  validateStage,
  validateStageMatrix,
  type StageName,
  type StageRecord,
} from './stages.ts'

export interface ReleaseOutput {
  readonly category: Exclude<ByteCategory, 'first-run-download'>
  readonly path: string
  readonly kind: 'file' | 'directory'
  /** Fresh outputs must not exist before the stage, even when a verifier passes. */
  readonly fresh: boolean
}
export interface ReleaseTask {
  /** Explicit benchmark-owned transfer before commands; never inferred from cache size. */
  readonly transfer?: ArtifactTransfer
  readonly dependsOn: readonly StageName[]
  readonly commands: readonly (readonly string[])[]
  readonly verify: readonly string[]
  readonly outputs: readonly ReleaseOutput[]
  readonly timeoutMs: number
  readonly environment?: Readonly<Record<string, string>>
}
export interface ReleasePlan {
  readonly schema: 1
  readonly framework: string
  readonly version: string
  readonly sourceCommit: string
  readonly tasks: Readonly<Partial<Record<StageName, ReleaseTask>>>
  readonly unsupported: Readonly<Partial<Record<StageName, string>>>
}
export interface ReleaseCommand {
  readonly stage: StageName
  readonly role: 'execute' | 'verify'
  readonly commandSha256: string
  readonly report: string
  readonly observation: CommandObservation | null
}
export interface ReleaseWorkflowReport {
  readonly schema: 1
  readonly runId: string
  readonly framework: string
  readonly version: string
  readonly sourceCommit: string
  readonly runClass: 'local-smoke'
  readonly passed: boolean
  readonly fullStageCoverage: boolean
  readonly stages: readonly StageRecord[]
  readonly bytes: readonly ByteObservation[]
  readonly commands: readonly ReleaseCommand[]
  readonly transfers: readonly { readonly stage: StageName; readonly report: TransferReport }[]
  readonly blockedBy: Readonly<Partial<Record<StageName, readonly StageName[]>>>
  readonly cleanupEstablished: boolean
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
function command(value: unknown): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 128 ||
    value.some((v) => typeof v !== 'string' || !v.length || v.includes('\0') || v.length > 8192)
  )
    throw new Error('Invalid command arguments')
}
function localPath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((p) => !p || p === '.' || p === '..' || p.includes(':'))
  )
    throw new Error('Output must be a relative contained path')
}
/** All stages are either executable or explicitly unsupported; dependencies may not cycle. */
export function validateReleasePlan(input: unknown): ReleasePlan {
  if (
    !object(input) ||
    input['schema'] !== 1 ||
    !object(input['tasks']) ||
    !object(input['unsupported'])
  )
    throw new Error('Invalid release plan')
  for (const key of ['framework', 'version'])
    if (
      typeof input[key] !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 ._+-]{0,127}$/.test(input[key] as string)
    )
      throw new Error('Invalid release identity')
  if (typeof input['sourceCommit'] !== 'string' || !/^[a-f0-9]{40}$/.test(input['sourceCommit']))
    throw new Error('Unpinned release source')
  const tasks = input['tasks'],
    unsupported = input['unsupported']
  if (
    [...Object.keys(tasks), ...Object.keys(unsupported)].some(
      (s) => !STAGES.includes(s as StageName)
    )
  )
    throw new Error('Unknown stage')
  const categories = new Set<string>(),
    transferPaths = new Set<string>()
  for (const stage of STAGES) {
    const task = tasks[stage],
      reason = unsupported[stage]
    if ((task !== undefined) === (reason !== undefined))
      throw new Error('Every stage needs exactly one disposition')
    if (task === undefined) {
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 4096)
        throw new Error('Missing unsupported reason')
      continue
    }
    if (
      !object(task) ||
      !Array.isArray(task['dependsOn']) ||
      new Set(task['dependsOn']).size !== task['dependsOn'].length ||
      task['dependsOn'].some((v) => !STAGES.includes(v as StageName) || v === stage) ||
      !Array.isArray(task['commands']) ||
      !task['commands'].length ||
      task['commands'].length > 32 ||
      !Array.isArray(task['outputs']) ||
      task['outputs'].length > 5 ||
      !Number.isSafeInteger(task['timeoutMs']) ||
      Number(task['timeoutMs']) < 100 ||
      Number(task['timeoutMs']) > 600000
    )
      throw new Error('Invalid release task')
    task['commands'].forEach(command)
    command(task['verify'])
    if (task['transfer'] !== undefined) {
      const transfer = validateArtifactTransfer(task['transfer'])
      if (
        (stage !== 'first-run' || transfer.category !== 'first-run-download') &&
        (stage !== 'update' || transfer.category !== 'update')
      )
        throw new Error('Transfer category must match first-run or update stage')
      if (categories.has(transfer.category))
        throw new Error('A byte category must have one declared measurement boundary')
      categories.add(transfer.category)
      const path = transfer.path.toLowerCase()
      for (const existing of transferPaths)
        if (
          path === existing ||
          path.startsWith(existing + '/') ||
          existing.startsWith(path + '/')
        ) {
          throw new Error('Transfer destinations must be distinct and non-overlapping')
        }
      transferPaths.add(path)
    }
    const environment = task['environment']
    if (
      environment !== undefined &&
      (!object(environment) ||
        Object.keys(environment).length > 32 ||
        Object.entries(environment).some(
          ([key, value]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
            key.startsWith('BUNLY_BENCH_') ||
            typeof value !== 'string' ||
            value.includes('\0') ||
            value.length > 16384
        ))
    )
      throw new Error('Invalid trusted stage environment')
    for (const output of task['outputs']) {
      if (
        !object(output) ||
        !BYTE_CATEGORIES.includes(output['category'] as ByteCategory) ||
        output['category'] === 'first-run-download' ||
        !['file', 'directory'].includes(String(output['kind'])) ||
        typeof output['fresh'] !== 'boolean'
      )
        throw new Error('Invalid release output')
      localPath(output['path'])
      if (
        output['kind'] === 'directory' &&
        !['installed', 'cache'].includes(String(output['category']))
      )
        throw new Error('Directory bytes are only installed or cache categories')
      if (output['category'] === 'installer' && output['kind'] !== 'file')
        throw new Error('Installer must be a file')
      if (categories.has(String(output['category'])))
        throw new Error('A byte category must have one declared measurement boundary')
      categories.add(String(output['category']))
      if (
        (output['category'] === 'installer' || output['category'] === 'update') &&
        !output['fresh']
      )
        throw new Error('Distribution artifacts must be fresh')
    }
  }
  // Even differently cased paths or ancestor directories may alias on a target.
  // Output inventory boundaries must not overlap controller-owned transfers.
  for (const task of Object.values(tasks) as ReleaseTask[])
    for (const output of task.outputs) {
      const path = output.path.toLowerCase()
      for (const transfer of transferPaths)
        if (
          path === transfer ||
          path.startsWith(transfer + '/') ||
          transfer.startsWith(path + '/')
        ) {
          throw new Error('Output boundary overlaps a transfer destination')
        }
    }
  const visiting = new Set<string>(),
    done = new Set<string>()
  function visit(stage: StageName): void {
    if (visiting.has(stage)) throw new Error('Cyclic release dependencies')
    if (done.has(stage)) return
    visiting.add(stage)
    const task = tasks[stage] as ReleaseTask | undefined
    task?.dependsOn.forEach(visit)
    visiting.delete(stage)
    done.add(stage)
  }
  STAGES.forEach(visit)
  // Copy the plan so callers cannot change commands while another stage is awaiting.
  return structuredClone(input) as unknown as ReleasePlan
}
async function contained(workspace: string, path: string): Promise<string> {
  localPath(path)
  const full = resolve(workspace, path)
  let cursor = workspace
  for (const part of path.split('/')) {
    cursor = join(cursor, part)
    const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (info?.isSymbolicLink()) throw new Error('Linked output path is not allowed')
  }
  return full
}
export function verifyReceipt(report: CommandObservation, stage: StageName, nonce: string): string {
  assertCleanCommand(report)
  const receipts: Record<string, unknown>[] = []
  for (const line of report.stdoutTail) {
    try {
      const value: unknown = JSON.parse(line)
      if (object(value) && value['event'] === 'benchmark-verification') receipts.push(value)
    } catch {
      /* Non-JSON diagnostics are not verification. */
    }
  }
  if (receipts.length !== 1) throw new Error('Expected one fresh verification receipt')
  const receipt = receipts[0]!
  if (
    receipt['stage'] !== stage ||
    receipt['nonce'] !== nonce ||
    receipt['passed'] !== true ||
    typeof receipt['evidence'] !== 'string' ||
    !receipt['evidence'].length ||
    receipt['evidence'].length > 4096
  )
    throw new Error('Invalid or stale verification receipt')
  return receipt['evidence']
}
/** No shell interpolation, implicit download, or implicit signing identity. */
export async function runReleaseWorkflow(
  input: unknown,
  options: {
    readonly workspace: string
    readonly output: string
    readonly signal?: AbortSignal
  }
): Promise<ReleaseWorkflowReport> {
  const plan = validateReleasePlan(input),
    workspace = await realpath(options.workspace),
    output = resolve(options.output)
  if (!(await lstat(workspace)).isDirectory()) throw new Error('Workspace must be a directory')
  await mkdir(output, { recursive: true, mode: 0o700 })
  const runId = randomBytes(24).toString('hex')
  const destination = join(output, runId)
  await mkdir(destination, { mode: 0o700 })
  const commands: ReleaseCommand[] = [],
    stages = new Map<StageName, StageRecord>()
  const transfers: { stage: StageName; report: TransferReport }[] = []
  const bytes = new Map<ByteCategory, ByteObservation>(
    BYTE_CATEGORIES.map((category) => [
      category,
      unavailableBytes(
        category,
        category === 'first-run-download'
          ? 'Child-process downloads are not traced; cache deltas are not network bytes'
          : 'No completed stage measured this category'
      ),
    ])
  )
  const blockedBy: Partial<Record<StageName, readonly StageName[]>> = {}
  let cleanupEstablished = true
  async function stage(name: StageName): Promise<void> {
    if (stages.has(name)) return
    const task = plan.tasks[name]
    if (!task) {
      stages.set(name, unsupportedStage(name, plan.unsupported[name]!))
      return
    }
    for (const dependency of task.dependsOn) await stage(dependency)
    const failed = task.dependsOn.filter((dep) => stages.get(dep)?.status !== 'passed')
    if (failed.length || !cleanupEstablished) {
      blockedBy[name] = failed
      stages.set(
        name,
        unsupportedStage(
          name,
          failed.length
            ? 'Not executed: prerequisite stages did not pass: ' + failed.join(', ')
            : 'Not executed: earlier process cleanup is unknown'
        )
      )
      return
    }
    const started = performance.now(),
      controller = new AbortController()
    const stop = () => controller.abort(new Error('Release stage cancelled'))
    options.signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, task.timeoutMs)
    if (options.signal?.aborted) stop()
    const nonce = randomBytes(24).toString('hex'),
      commandTimeoutMs = task.timeoutMs,
      environment = task.environment
    async function execute(
      args: readonly string[],
      role: ReleaseCommand['role']
    ): Promise<CommandObservation> {
      controller.signal.throwIfAborted()
      const report = `${String(commands.length).padStart(3, '0')}-${name}-${role}.json`,
        index = commands.length
      const entry = {
        stage: name,
        role,
        commandSha256: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
        report,
        observation: null,
      } satisfies ReleaseCommand
      commands.push(entry)
      const child = observedCommand(args, {
        cwd: workspace,
        output: join(destination, report),
        timeoutMs: commandTimeoutMs,
        signal: controller.signal,
        env: {
          ...environment,
          BUNLY_BENCH_STAGE: name,
          BUNLY_BENCH_NONCE: nonce,
          BUNLY_BENCH_RUN_ID: runId,
        },
      })
      try {
        const observation = await child.result
        commands[index] = { ...entry, observation }
        if (observation.cleanupSurvivors.length) cleanupEstablished = false
        assertCleanCommand(observation)
        return observation
      } catch (error) {
        if (commands[index]?.observation === null) cleanupEstablished = false
        throw error
      }
    }
    try {
      controller.signal.throwIfAborted()
      for (const result of task.outputs) {
        const path = await contained(workspace, result.path)
        if (result.fresh) {
          const exists = await lstat(path).then(
            () => true,
            (e: NodeJS.ErrnoException) => {
              if (e.code !== 'ENOENT') throw e
              return false
            }
          )
          if (exists) throw new Error('Fresh output already exists: ' + result.path)
        }
      }
      if (task.transfer) {
        const report = await transferArtifact(task.transfer, {
          workspace,
          timeoutMs: task.timeoutMs,
          signal: controller.signal,
        })
        transfers.push({ stage: name, report })
        if (!report.cleanupEstablished) cleanupEstablished = false
        if (report.status !== 'passed')
          throw new Error(report.errorCode ?? 'Artifact transfer failed')
        // Received bytes remain measured even if the subsequent app launch fails.
        // They cannot make the stage pass or account for unobserved child traffic.
        bytes.set(task.transfer.category, transferBytes(report))
      }
      for (const args of task.commands) await execute(args, 'execute')
      const evidence = verifyReceipt(await execute(task.verify, 'verify'), name, nonce)
      const measured: ByteObservation[] = []
      for (const result of task.outputs) {
        const path = await contained(workspace, result.path)
        if (result.kind === 'directory') {
          if (result.category !== 'installed' && result.category !== 'cache')
            throw new Error('Invalid directory category')
          measured.push(await directoryBytes(result.category, path, evidence))
        } else measured.push(await fileBytes(result.category, path, evidence))
      }
      controller.signal.throwIfAborted()
      if (performance.now() - started >= task.timeoutMs)
        throw new Error('Stage deadline exceeded while verifying outputs')
      measured.forEach((row) => bytes.set(row.category, row))
      stages.set(
        name,
        validateStage({
          stage: name,
          status: 'passed',
          elapsedMs: performance.now() - started,
          reason: 'Commands reaped, fresh verifier acknowledged, declared output bytes checked',
          validation: { passed: true, evidence },
        })
      )
    } catch (error) {
      stages.set(
        name,
        validateStage({
          stage: name,
          status: 'failed',
          elapsedMs: performance.now() - started,
          reason: error instanceof Error ? error.message.slice(0, 4096) : 'Release stage failed',
          validation: {
            passed: false,
            evidence: 'No successful complete stage validation; dependent work remains unexecuted',
          },
        })
      )
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', stop)
    }
  }
  for (const name of STAGES) await stage(name)
  const rows = validateStageMatrix(STAGES.map((name) => stages.get(name)!))
  return {
    schema: 1,
    runId,
    framework: plan.framework,
    version: plan.version,
    sourceCommit: plan.sourceCommit,
    runClass: 'local-smoke',
    passed:
      Object.keys(plan.tasks).length > 0 &&
      Object.keys(plan.tasks).every((name) => stages.get(name as StageName)?.status === 'passed') &&
      cleanupEstablished,
    fullStageCoverage: rows.every((row) => row.status === 'passed'),
    stages: rows,
    bytes: validateByteMatrix([...bytes.values()]),
    commands: commands.map((row) => ({
      ...row,
      report: relative(output, join(destination, row.report)),
    })),
    transfers,
    blockedBy,
    cleanupEstablished,
  }
}
