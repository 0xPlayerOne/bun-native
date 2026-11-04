import { mkdtempSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleProject } from './build.ts'
import { readProject } from './project.ts'

const diagnosticKeys = [
  'windows',
  'nodes',
  'callbacks',
  'queuedTransactions',
  'queuedCallbacks',
  'activeCallbacks',
  'serviceRequests',
] as const

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

type StoppedResources = {
  application: Record<(typeof diagnosticKeys)[number], 0>
  nodes: 0
}

export type TeardownReport = StoppedResources & { pid: number; clean: true }

function cleanStop(value: Record<string, unknown>): StoppedResources | undefined {
  const application = record(value['application'])
  if (
    value['nodes'] !== 0 ||
    application === undefined ||
    !diagnosticKeys.every((key) => application[key] === 0)
  )
    return undefined
  return {
    // Copy only the counters validated above; retain no arbitrary child payload.
    application: Object.fromEntries(
      diagnosticKeys.map((key) => [key, application[key]])
    ) as StoppedResources['application'],
    nodes: 0,
  }
}

async function bounded<T>(value: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

type OwnedProcess = {
  child: Bun.Subprocess<'ignore', 'inherit', 'inherit'>
  directory: string
  ready: Promise<void>
  exited: Promise<number>
  disconnected: Promise<void>
  terminated: boolean
  mounted: boolean
  stopping: boolean
  resources: StoppedResources | undefined
}

export type RemountReport = {
  generation: number
  pid: number
  bundle: string
  bundleMs: number
  shutdownMs: number
  mountMs: number
  editToReadyMs: number
  previous?: TeardownReport
}

/** One app process at a time; its native host belongs to that app's public core. */
export class DevSession {
  private current: OwnedProcess | undefined
  private active: Promise<RemountReport> | undefined
  private closing: Promise<TeardownReport | undefined> | undefined
  private stopped = false
  private generation = 0
  private readonly completion = Promise.withResolvers<number>()
  readonly exited = this.completion.promise
  readonly temporaryDirectory: string

  constructor(
    private readonly repository: string,
    private readonly projectDirectory: string,
    private readonly host: string,
    private readonly timeoutMs = 5_000
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new Error('Dev session timeout must be between 1 and 60000 milliseconds')
    this.temporaryDirectory = mkdtempSync(join(tmpdir(), 'bun-native-dev-'))
  }

  reload(changedAt = performance.now()): Promise<RemountReport> {
    if (this.stopped) return Promise.reject(new Error('Development session is closed'))
    if (this.active) return Promise.reject(new Error('A reload is already running'))
    this.active = this.replace(changedAt).finally(() => {
      this.active = undefined
    })
    return this.active
  }

  close(): Promise<TeardownReport | undefined> {
    this.stopped = true
    return (this.closing ??= (async () => {
      try {
        await this.active?.catch(() => {})
        const previous = this.current
        this.current = undefined
        let teardown: TeardownReport | undefined
        if (previous) {
          try {
            teardown = await this.stop(previous)
          } finally {
            if (!previous.terminated) this.current = previous
          }
        }
        this.completion.resolve(0)
        return teardown
      } finally {
        // A failed app can already be reaped while its teardown error must still
        // propagate. Remove only this session's root once no process owns it.
        if (!this.current) await rm(this.temporaryDirectory, { recursive: true, force: true })
      }
    })())
  }

  private launch(entry: string, directory: string): OwnedProcess {
    const ready = Promise.withResolvers<void>()
    const disconnected = Promise.withResolvers<void>()
    // A synchronous spawn failure or immediate exit must never orphan a rejection.
    void ready.promise.catch(() => {})
    let owner: OwnedProcess | undefined
    const child = Bun.spawn([process.execPath, entry], {
      cwd: this.projectDirectory,
      env: { ...process.env, BUN_NATIVE_HOST: this.host },
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      ipc(message: unknown) {
        const value = record(message)
        if (value?.['type'] === 'bun-native:ready' && owner && !owner.stopping) {
          owner.mounted = true
          ready.resolve()
        } else if (value?.['type'] === 'bun-native:stopped' && owner) {
          owner.resources = cleanStop(value)
        }
      },
      onDisconnect: () => {
        disconnected.resolve()
      },
      onExit: async (_child, code, signal) => {
        ready.reject(new Error(`Application exited before readiness (${code ?? signal})`))
        // Exit notification can precede the final IPC message on a different pipe.
        await disconnected.promise
        if (owner?.mounted && !owner.stopping) {
          this.stopped = true
          this.completion.resolve(code === 0 && owner.resources ? 0 : 1)
        }
      },
    })
    const exited = child.exited.then((code) => {
      if (owner) owner.terminated = true
      return code
    })
    owner = {
      child,
      directory,
      ready: ready.promise,
      exited,
      disconnected: disconnected.promise,
      terminated: false,
      mounted: false,
      stopping: false,
      resources: undefined,
    }
    return owner
  }

  private async stop(owner: OwnedProcess): Promise<TeardownReport> {
    owner.stopping = true
    try {
      if (!owner.terminated && !owner.resources) {
        // The child may be closing normally while this request is in flight.
        // Always join exit and validate its final acknowledgement below.
        try {
          owner.child.send({ type: 'bun-native:stop' })
        } catch {
          /* joined below */
        }
      }
      const [code] = await bounded(
        Promise.all([owner.exited, owner.disconnected]),
        this.timeoutMs,
        'Application did not acknowledge shutdown in time'
      )
      if (code !== 0 || !owner.resources)
        throw new Error(
          `Application did not report clean teardown (exit ${code}); preserve the template dev-control hooks`
        )
      return { pid: owner.child.pid, clean: true, ...owner.resources }
    } catch (error) {
      if (!owner.terminated) {
        owner.child.kill('SIGKILL')
        await bounded(
          Promise.all([owner.exited, owner.disconnected]),
          this.timeoutMs,
          'Application did not exit after termination'
        )
      }
      throw error
    } finally {
      if (owner.terminated) {
        await rm(owner.directory, { recursive: true, force: true })
      }
    }
  }

  private async replace(changedAt: number): Promise<RemountReport> {
    const project = await readProject(this.repository, this.projectDirectory)
    const directory = await mkdtemp(join(this.temporaryDirectory, 'generation-'))
    let owner: OwnedProcess | undefined
    const start = performance.now()
    try {
      // Compile before touching the live app, so an incomplete edit preserves it.
      const entry = await bundleProject(project, directory)
      const bundled = performance.now()
      if (this.stopped) throw new Error('Development session is closed')
      const previous = this.current
      this.current = undefined
      let teardown: TeardownReport | undefined
      if (previous) {
        try {
          teardown = await this.stop(previous)
        } catch (error) {
          if (!previous.terminated) this.current = previous
          this.stopped = true
          this.completion.resolve(1)
          throw error
        }
      }
      const joined = performance.now()
      if (this.stopped) throw new Error('Development session is closed')
      owner = this.launch(entry, directory)
      this.current = owner
      await bounded(
        owner.ready,
        this.timeoutMs,
        'Application readiness timed out; preserve the template dev-control hooks'
      )
      const ready = performance.now()
      return {
        generation: ++this.generation,
        pid: owner.child.pid,
        bundle: entry,
        bundleMs: bundled - start,
        shutdownMs: joined - bundled,
        mountMs: ready - joined,
        editToReadyMs: ready - changedAt,
        ...(teardown ? { previous: teardown } : {}),
      }
    } catch (error) {
      if (owner) {
        this.stopped = true
        this.completion.resolve(1)
        try {
          await this.stop(owner)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Application startup failed and the session was stopped'
          )
        } finally {
          if (owner.terminated) this.current = undefined
        }
      }
      throw error
    } finally {
      if (!owner || (owner.terminated && owner !== this.current))
        await rm(directory, { recursive: true, force: true })
    }
  }
}
