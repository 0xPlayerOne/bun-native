import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DevelopmentError } from './dev-cache.ts'

export interface DevelopmentBundle {
  readonly entry: string
  readonly sourceMap: string
  readonly generationDirectory: string
  readonly signal: AbortSignal
}
export interface DevelopmentDiagnostic {
  readonly schema: 1
  readonly event: 'ready' | 'build' | 'reload' | 'frontend' | 'restart' | 'error' | 'closed'
  readonly sequence: number
  readonly stage: 'startup' | 'bundle' | 'replace' | 'frontend' | 'configuration' | 'shutdown'
  readonly durationMs: number
  readonly code: string
  readonly restartRequired: boolean
  readonly message: string
  readonly location?: { file: string; line: number; column: number }
}
export interface DevelopmentChangeResult {
  readonly action: 'reloaded' | 'frontend' | 'both' | 'ignored' | 'restart-required' | 'failed'
  readonly sequence: number
  readonly durationMs: number
  readonly backendReplaced: boolean
  readonly frontendNotified: boolean
}
export interface DevelopmentSessionOptions {
  readonly projectRoot: string
  readonly entrypoint: string
  /** Existing directories; the native filesystem watcher observes additions and removals recursively. */
  readonly backendRoots: readonly string[]
  readonly frontendRoots?: readonly string[]
  readonly sharedRoots?: readonly string[]
  readonly generatedRoots?: readonly string[]
  readonly cacheRoot: string
  readonly instanceId?: string
  /** JSON only. It is validated before restart admission, never evaluated in the stable owner. */
  readonly configurationFile?: string
  /** Stable bootstrap/native/ABI/engine inputs require a full restart, not application replacement. */
  readonly restartFiles?: readonly string[]
  /** The externally owned frontend server keeps its own HMR protocol and process lifetime. */
  readonly frontendOrigin?: string
  readonly frontendTimeoutMs?: number
  /** Optional read-only loopback diagnostics. An occupied requested port fails explicitly. */
  readonly diagnosticPort?: number
  readonly watch?: boolean
  readonly debounceMs?: number
  readonly maxPendingChanges?: number
  readonly maxDependencies?: number
  /** Resolve after retirement is confirmed. On uncertain cleanup throw { restartRequired:true, candidateRetired:false }. */
  readonly reload: (bundle: DevelopmentBundle) => Promise<unknown>
  /** Resolve only after the generation broker has stopped and all retained work has settled. */
  readonly shutdown: () => Promise<void>
  readonly frontendChanged?: (files: readonly string[], signal: AbortSignal) => Promise<void>
  readonly onDiagnostic?: (diagnostic: DevelopmentDiagnostic) => void
  readonly restartRequired?: (reason: string) => void
}
interface ChangeWaiter {
  resolve(result: DevelopmentChangeResult): void
  reject(error: Error): void
}
interface PendingChanges {
  paths: Set<string>
  waiters: ChangeWaiter[]
  initial: boolean
}
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
const errorCode = (error: unknown): string => {
  const value = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return typeof value === 'string' && /^[A-Z_]{1,64}$/.test(value) ? value : 'RELOAD_FAILED'
}
function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new DevelopmentError('INVALID_CONFIG', `Invalid ${name}`)
  return value
}
async function fingerprint(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile())
      throw new DevelopmentError('INVALID_CONFIG', 'Restart-sensitive inputs must be regular files')
    const hasher = createHash('sha256')
    for await (const chunk of createReadStream(path)) hasher.update(chunk)
    return hasher.digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function loopbackOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new DevelopmentError(
      'INVALID_CONFIG',
      'Frontend origin must be an exact numeric-loopback HTTP origin'
    )
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw new DevelopmentError(
      'INVALID_CONFIG',
      'Frontend origin must be an exact numeric-loopback HTTP origin'
    )
  return value
}
async function probeFrontend(
  origin: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<void> {
  try {
    const response = await fetch(origin, {
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error()
  } catch {
    throw new DevelopmentError(
      'FRONTEND_UNAVAILABLE',
      'External frontend server is unavailable at the configured origin'
    )
  }
}

/**
 * The stable desktop owner supplies the reload/shutdown callbacks. This package does not import
 * runtime authority, launch native compilers, resolve packages itself, or own the frontend server.
 */
export class DevelopmentSession {
  readonly #options: DevelopmentSessionOptions
  readonly #controller = new AbortController()
  readonly #watchers = new Map<string, FSWatcher>()
  readonly #restartFingerprints = new Map<string, string | null>()
  readonly #dependencies = new Set<string>()
  readonly #backend: readonly string[]
  readonly #frontend: readonly string[]
  readonly #shared: readonly string[]
  readonly #generated: readonly string[]
  readonly #entry: string
  readonly #root: string
  readonly #cache: string
  readonly #instance: string
  readonly #maxPending: number
  readonly #maxDependencies: number
  readonly #debounce: number
  readonly #frontendTimeout: number
  readonly #config: string | undefined
  readonly #restartFiles: readonly string[]
  #server: Bun.Server<undefined> | undefined
  #pending: PendingChanges | undefined
  #running: Promise<void> | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #closed = false
  #requiresRestart = false
  #closePromise: Promise<void> | undefined
  #activeDirectory: string | undefined
  #sequence = 0
  #builds = 0
  #replacements = 0
  #frontendEvents = 0
  #retainedDirectories = new Set<string>()

  private constructor(options: DevelopmentSessionOptions, root: string, cache: string) {
    this.#options = options
    this.#root = root
    this.#cache = cache
    this.#entry = resolve(root, options.entrypoint)
    this.#backend = options.backendRoots.map((path) => resolve(root, path))
    this.#frontend = (options.frontendRoots ?? []).map((path) => resolve(root, path))
    this.#shared = (options.sharedRoots ?? []).map((path) => resolve(root, path))
    this.#generated = (options.generatedRoots ?? []).map((path) => resolve(root, path))
    this.#maxPending = boundedInteger(
      options.maxPendingChanges ?? 1024,
      1,
      16384,
      'change capacity'
    )
    this.#maxDependencies = boundedInteger(
      options.maxDependencies ?? 4096,
      1,
      16384,
      'dependency capacity'
    )
    this.#debounce = boundedInteger(options.debounceMs ?? 25, 0, 1000, 'watch debounce')
    this.#frontendTimeout = boundedInteger(
      options.frontendTimeoutMs ?? 2000,
      1,
      10000,
      'frontend deadline'
    )
    this.#config =
      options.configurationFile === undefined ? undefined : resolve(root, options.configurationFile)
    this.#restartFiles = [
      ...new Set([
        ...['package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json'].map((path) =>
          resolve(root, path)
        ),
        ...(this.#config ? [this.#config] : []),
        ...(options.restartFiles ?? []).map((path) => resolve(root, path)),
      ]),
    ]
    const instanceId = options.instanceId ?? randomUUID()
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(instanceId))
      throw new DevelopmentError('INVALID_CONFIG', 'Invalid development instance identifier')
    this.#instance = join(cache, 'instances', instanceId)
  }

  static async start(options: DevelopmentSessionOptions): Promise<DevelopmentSession> {
    const root = await realpath(options.projectRoot)
    const cachePath = resolve(root, options.cacheRoot)
    await mkdir(cachePath, { recursive: true, mode: 0o700 })
    const cacheStat = await lstat(cachePath)
    if (
      !cacheStat.isDirectory() ||
      cacheStat.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((cacheStat.mode & 0o077) !== 0 || cacheStat.uid !== process.getuid?.()))
    )
      throw new DevelopmentError(
        'INVALID_CONFIG',
        'Development session cache must be a private directory'
      )
    const session = new DevelopmentSession(options, root, await realpath(cachePath))
    await session.#validate()
    await mkdir(join(session.#cache, 'instances'), { recursive: true, mode: 0o700 })
    try {
      await mkdir(session.#instance, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new DevelopmentError(
          'INSTANCE_BUSY',
          'This instance identifier is already owned; use a distinct instance for another workspace'
        )
      throw error
    }
    try {
      for (const path of session.#restartFiles)
        session.#restartFingerprints.set(path, await fingerprint(path))
      if (options.diagnosticPort !== undefined) {
        boundedInteger(options.diagnosticPort, 0, 65535, 'diagnostic port')
        try {
          session.#server = Bun.serve({
            hostname: '127.0.0.1',
            port: options.diagnosticPort,
            fetch(request) {
              const url = new URL(request.url)
              if (request.method !== 'GET' || url.pathname !== '/__bunly/health')
                return new Response('Not found', { status: 404 })
              return Response.json(session.diagnostics(), {
                headers: { 'Cache-Control': 'no-store' },
              })
            },
          })
        } catch {
          throw new DevelopmentError(
            'PORT_IN_USE',
            'The requested development diagnostic port is unavailable'
          )
        }
      }
      if (options.frontendOrigin !== undefined)
        await probeFrontend(
          loopbackOrigin(options.frontendOrigin),
          session.#frontendTimeout,
          session.#controller.signal
        )
      if (options.watch !== false) await session.#installWatchers()
      const initial = await session.#enqueue([session.#entry], true)
      if (!initial.backendReplaced)
        throw new DevelopmentError(
          'BUILD_FAILED',
          'Initial application generation did not become ready'
        )
      session.#diagnostic(
        'ready',
        'startup',
        0,
        'READY',
        'Prepared host is reused; application generation is ready'
      )
      return session
    } catch (error) {
      try {
        await session.close()
      } catch {
        throw Object.assign(
          new DevelopmentError(
            'RESTART_REQUIRED',
            'Startup failed and owned runtime cleanup could not be confirmed'
          ),
          { cause: error }
        )
      }
      throw error
    }
  }

  async #validate(): Promise<void> {
    if (!inside(this.#root, this.#entry) || !(await lstat(this.#entry)).isFile())
      throw new DevelopmentError('INVALID_CONFIG', 'Backend entry must be a file in the project')
    const roots = [...this.#backend, ...this.#frontend, ...this.#shared, ...this.#generated]
    if (!this.#backend.length || roots.length > 128)
      throw new DevelopmentError(
        'INVALID_CONFIG',
        'Declare bounded backend and frontend source roots'
      )
    for (const path of roots) {
      const actual = await realpath(path)
      if (
        !inside(this.#root, actual) ||
        !(await lstat(actual)).isDirectory() ||
        inside(actual, this.#cache)
      )
        throw new DevelopmentError(
          'INVALID_CONFIG',
          'Source roots must be project directories outside the development cache'
        )
    }
    if (
      !this.#backend.some((path) => inside(path, this.#entry)) &&
      !this.#shared.some((path) => inside(path, this.#entry))
    )
      throw new DevelopmentError(
        'INVALID_CONFIG',
        'Backend entry must belong to a declared backend source root'
      )
    await this.#validateConfig()
    if (this.#options.frontendOrigin !== undefined) loopbackOrigin(this.#options.frontendOrigin)
    if (this.#restartFiles.length > 1024)
      throw new DevelopmentError('INVALID_CONFIG', 'Too many restart-sensitive inputs')
  }
  async #validateConfig(): Promise<void> {
    if (!this.#config) return
    try {
      const stat = await lstat(this.#config)
      if (!stat.isFile() || stat.size > 65536) throw new Error()
      JSON.parse(await readFile(this.#config, 'utf8'))
    } catch {
      throw new DevelopmentError(
        'INVALID_CONFIG',
        'Host configuration is invalid; the serving generation remains unchanged'
      )
    }
  }
  #diagnostic(
    event: DevelopmentDiagnostic['event'],
    stage: DevelopmentDiagnostic['stage'],
    durationMs: number,
    code: string,
    message: string,
    location?: DevelopmentDiagnostic['location']
  ): void {
    const diagnostic: DevelopmentDiagnostic = Object.freeze({
      schema: 1,
      event,
      sequence: this.#sequence,
      stage,
      durationMs,
      code,
      restartRequired: this.#requiresRestart,
      message,
      ...(location ? { location } : {}),
    })
    // Diagnostics must not turn an already committed generation into a failed transaction.
    try {
      this.#options.onDiagnostic?.(diagnostic)
    } catch {
      /* observer only */
    }
  }
  #restart(reason: string): void {
    this.#requiresRestart = true
    this.#diagnostic('restart', 'configuration', 0, 'RESTART_REQUIRED', reason)
    try {
      this.#options.restartRequired?.(reason)
    } catch {
      /* observer only */
    }
  }
  #relative(path: string): string {
    return inside(this.#root, path)
      ? relative(this.#root, path).split(sep).join('/')
      : '<external-dependency>'
  }
  async #watchDirectory(path: string, recursive: boolean): Promise<void> {
    if (this.#watchers.has(path) || this.#options.watch === false || this.#closed) return
    if (this.#watchers.size >= this.#maxDependencies + 128)
      throw new DevelopmentError('CAPACITY', 'Dependency watcher capacity exceeded')
    const watcher = watch(path, { recursive }, (_event, filename) => {
      if (this.#closed || this.#requiresRestart) return
      if (filename === null) {
        this.#restart(
          'Filesystem notification omitted its path; restart to revalidate all host inputs'
        )
        return
      }
      const changed = resolve(path, filename.toString())
      if (inside(this.#cache, changed)) return
      void this.invalidate([changed]).catch(() => {})
    })
    watcher.on('error', () =>
      this.#restart('Filesystem watcher failed; restart to restore complete dependency observation')
    )
    this.#watchers.set(path, watcher)
  }
  async #installWatchers(): Promise<void> {
    const roots = [
      ...new Set([...this.#backend, ...this.#frontend, ...this.#shared, ...this.#generated]),
    ].filter((path, _index, all) => !all.some((other) => other !== path && inside(other, path)))
    for (const path of roots) await this.#watchDirectory(path, true)
    for (const path of this.#restartFiles) {
      if (roots.some((root) => inside(root, path))) continue
      await this.#watchDirectory(dirname(path), false)
    }
  }
  async #trackDependencies(paths: readonly string[]): Promise<void> {
    if (paths.length > this.#maxDependencies)
      throw new DevelopmentError(
        'CAPACITY',
        'Backend dependency graph exceeds the configured bound'
      )
    this.#dependencies.clear()
    for (const path of paths) this.#dependencies.add(path)
    const roots = [...this.#backend, ...this.#frontend, ...this.#shared, ...this.#generated]
    const needed = new Set([
      ...roots,
      ...this.#restartFiles.map(dirname),
      ...paths.filter((path) => !roots.some((root) => inside(root, path))).map(dirname),
    ])
    for (const [path, watcher] of this.#watchers) {
      if (!needed.has(path)) {
        watcher.close()
        this.#watchers.delete(path)
      }
    }
    for (const path of paths)
      if (!roots.some((root) => inside(root, path)))
        await this.#watchDirectory(dirname(path), false)
  }

  invalidate(paths: readonly string[]): Promise<DevelopmentChangeResult> {
    return this.#enqueue(paths, false)
  }
  #enqueue(paths: readonly string[], initial: boolean): Promise<DevelopmentChangeResult> {
    if (this.#closed)
      return Promise.reject(new DevelopmentError('CLOSED', 'Development session is closed'))
    if (
      !Array.isArray(paths) ||
      paths.length > this.#maxPending ||
      paths.some((path) => typeof path !== 'string')
    )
      return Promise.reject(new DevelopmentError('CAPACITY', 'Change batch exceeds its bound'))
    const pending = this.#pending ?? { paths: new Set<string>(), waiters: [], initial }
    if (pending.waiters.length >= 64 || pending.paths.size + paths.length > this.#maxPending) {
      this.#restart('Change backlog exceeded its bound; restart to revalidate all changed inputs')
      return Promise.reject(new DevelopmentError('CAPACITY', 'Change backlog exceeds its bound'))
    }
    for (const path of paths) pending.paths.add(resolve(this.#root, path))
    pending.initial ||= initial
    this.#pending = pending
    const promise = new Promise<DevelopmentChangeResult>((resolve, reject) =>
      pending.waiters.push({ resolve, reject })
    )
    if (!this.#running && !this.#timer) {
      if (initial || this.#debounce === 0) this.#startDrain()
      else
        this.#timer = setTimeout(() => {
          this.#timer = undefined
          this.#startDrain()
        }, this.#debounce)
    }
    return promise
  }
  #startDrain(): void {
    if (this.#running || this.#closed) return
    this.#running = this.#drain().finally(() => {
      this.#running = undefined
      if (this.#pending && !this.#closed) this.#startDrain()
    })
  }
  async #drain(): Promise<void> {
    while (this.#pending && !this.#closed) {
      const pending = this.#pending
      this.#pending = undefined
      try {
        const result = await this.#apply([...pending.paths], pending.initial)
        for (const waiter of pending.waiters) waiter.resolve(result)
      } catch (error) {
        const failure = error instanceof Error ? error : new Error('Development transition failed')
        for (const waiter of pending.waiters) waiter.reject(failure)
      }
    }
  }
  async #apply(paths: readonly string[], initial: boolean): Promise<DevelopmentChangeResult> {
    const start = performance.now()
    const sequence = ++this.#sequence
    let backendReplaced = false,
      frontendNotified = false
    const result = (action: DevelopmentChangeResult['action']): DevelopmentChangeResult =>
      Object.freeze({
        action,
        sequence,
        durationMs: performance.now() - start,
        backendReplaced,
        frontendNotified,
      })
    if (this.#requiresRestart) return result('restart-required')
    // Even coalesced backend events cannot skip a simultaneous configuration change.
    const changes = await Promise.all(
      this.#restartFiles.map(async (path) => ({
        path,
        changed: (await fingerprint(path)) !== this.#restartFingerprints.get(path),
      }))
    )
    if (changes.some((item) => item.changed)) {
      try {
        await this.#validateConfig()
      } catch (error) {
        this.#diagnostic(
          'error',
          'configuration',
          performance.now() - start,
          errorCode(error),
          'Invalid host configuration; previous generation remains active'
        )
        return result('failed')
      }
      this.#restart(
        'Host configuration, lockfile, bootstrap or native inputs changed; a full restart is required and loses managed resource persistence'
      )
      return result('restart-required')
    }
    const shared = paths.some((path) =>
      [...this.#shared, ...this.#generated].some((root) => inside(root, path))
    )
    const backend =
      initial ||
      shared ||
      paths.some(
        (path) => this.#dependencies.has(path) || this.#backend.some((root) => inside(root, path))
      )
    const frontend =
      !initial &&
      (shared || paths.some((path) => this.#frontend.some((root) => inside(root, path))))
    if (!backend && !frontend) return result('ignored')
    if (backend) {
      const directory = join(this.#instance, `generation-${sequence}`)
      await mkdir(directory, { mode: 0o700 })
      this.#retainedDirectories.add(directory)
      const bundleStarted = performance.now()
      let built: Bun.BuildOutput
      const dependencies = new Set<string>()
      const maxDependencies = this.#maxDependencies
      let inputFailure: DevelopmentError | undefined
      try {
        this.#builds++
        built = await Bun.build({
          entrypoints: [this.#entry],
          outdir: directory,
          naming: 'application.js',
          target: 'bun',
          format: 'esm',
          sourcemap: 'linked',
          packages: 'bundle',
          metafile: true,
          plugins: [
            {
              name: 'bunly-development-inputs',
              setup(build) {
                build.onLoad({ filter: /.*/, namespace: 'file' }, ({ path }) => {
                  if (inputFailure) throw inputFailure
                  if (!isAbsolute(path)) {
                    inputFailure = new DevelopmentError(
                      'BUILD_FAILED',
                      'Bun returned a non-absolute filesystem input'
                    )
                    throw inputFailure
                  }
                  if (!dependencies.has(path)) {
                    if (dependencies.size >= maxDependencies) {
                      inputFailure = new DevelopmentError(
                        'CAPACITY',
                        'Backend dependency graph exceeds the configured bound'
                      )
                      throw inputFailure
                    }
                    dependencies.add(path)
                  }
                  // Observe resolved files only; Bun still performs its normal load.
                  return undefined
                })
              },
            },
          ],
          allowUnresolved: [],
          minify: false,
          throw: false,
        })
        // Bun converts callback exceptions to BuildMessages under throw:false.
        // Preserve the original structured host error after the build settles.
        if (inputFailure) throw inputFailure
        if (!built.success || !built.metafile) {
          for (const message of built.logs.slice(0, 32)) {
            const position = message.position
            this.#diagnostic(
              'error',
              'bundle',
              performance.now() - bundleStarted,
              'BUILD_FAILED',
              message.message.slice(0, 4096),
              position
                ? {
                    file: this.#relative(resolve(position.file)),
                    line: position.line,
                    column: position.column,
                  }
                : undefined
            )
          }
          throw new DevelopmentError('BUILD_FAILED', 'Application bundling failed')
        }
        if (dependencies.size === 0)
          throw new DevelopmentError('BUILD_FAILED', 'Bun did not report filesystem inputs')
        // Metafile keys are display paths. Bun 1.4.3 can emit non-resolvable
        // cross-drive keys on Windows; only actual file loads define watchers.
        await this.#trackDependencies([...dependencies])
        this.#diagnostic(
          'build',
          'bundle',
          performance.now() - bundleStarted,
          'BUILT',
          `Bundled ${dependencies.size} dependencies with linked source maps`
        )
      } catch (error) {
        this.#diagnostic(
          'error',
          'bundle',
          performance.now() - bundleStarted,
          errorCode(error),
          'Build rejected; previous generation remains active'
        )
        await rm(directory, { recursive: true, force: true })
        this.#retainedDirectories.delete(directory)
        return result('failed')
      }
      const reloadStarted = performance.now()
      let dispatched = false
      try {
        this.#controller.signal.throwIfAborted()
        for (const path of this.#restartFiles) {
          if ((await fingerprint(path)) !== this.#restartFingerprints.get(path)) {
            await this.#validateConfig()
            this.#restart(
              'Host inputs changed while application code was bundling; restart before publishing a replacement'
            )
            await rm(directory, { recursive: true, force: true })
            this.#retainedDirectories.delete(directory)
            return result('restart-required')
          }
        }
        const entry = join(directory, 'application.js')
        dispatched = true
        await this.#options.reload({
          entry,
          sourceMap: entry + '.map',
          generationDirectory: directory,
          signal: this.#controller.signal,
        })
        const old = this.#activeDirectory
        this.#activeDirectory = directory
        backendReplaced = true
        this.#replacements++
        // The adapter resolves only after actual retirement. Uncertain cleanup must reject.
        if (old) {
          await rm(old, { recursive: true, force: true })
          this.#retainedDirectories.delete(old)
        }
        this.#diagnostic(
          'reload',
          'replace',
          performance.now() - reloadStarted,
          'RELOADED',
          'Replacement is ready; stable native resources remain owned by the desktop host'
        )
      } catch (error) {
        const status = error as {
          restartRequired?: boolean
          candidateRetired?: boolean
          committed?: boolean
        }
        if (
          status?.restartRequired === true ||
          (dispatched && status?.candidateRetired !== true) ||
          status?.committed === true
        ) {
          this.#restart(
            'Generation cleanup or cutover is uncertain; preserve artifacts and perform a controlled full restart'
          )
        } else {
          await rm(directory, { recursive: true, force: true })
          this.#retainedDirectories.delete(directory)
        }
        this.#diagnostic(
          'error',
          'replace',
          performance.now() - reloadStarted,
          errorCode(error),
          'Replacement failed; no mutation is automatically replayed'
        )
        return result(this.#requiresRestart ? 'restart-required' : 'failed')
      }
    }
    if (frontend) {
      const frontendStarted = performance.now()
      try {
        if (this.#options.frontendChanged) {
          await this.#options.frontendChanged(
            paths.map((path) => this.#relative(path)),
            this.#controller.signal
          )
          frontendNotified = true
        }
        this.#frontendEvents++
        this.#diagnostic(
          'frontend',
          'frontend',
          performance.now() - frontendStarted,
          'FRONTEND_CHANGED',
          frontendNotified
            ? 'Frontend integration acknowledged the change; its tooling retains the HMR connection'
            : 'Frontend edit observed; external tooling owns HMR and no notification callback was configured'
        )
      } catch (error) {
        this.#diagnostic(
          'error',
          'frontend',
          performance.now() - frontendStarted,
          errorCode(error),
          'Frontend notification failed'
        )
        return result('failed')
      }
    }
    return result(backendReplaced ? (frontendNotified ? 'both' : 'reloaded') : 'frontend')
  }

  diagnostics(): Readonly<{
    schema: 1
    closed: boolean
    restartRequired: boolean
    sequence: number
    builds: number
    replacements: number
    frontendEvents: number
    watchedDirectories: number
    dependencies: number
    pendingChanges: number
    pendingCallers: number
    retainedBundles: number
    diagnosticPort: number | null
  }> {
    return Object.freeze({
      schema: 1,
      closed: this.#closed,
      restartRequired: this.#requiresRestart,
      sequence: this.#sequence,
      builds: this.#builds,
      replacements: this.#replacements,
      frontendEvents: this.#frontendEvents,
      watchedDirectories: this.#watchers.size,
      dependencies: this.#dependencies.size,
      pendingChanges: this.#pending?.paths.size ?? 0,
      pendingCallers: this.#pending?.waiters.length ?? 0,
      retainedBundles: this.#retainedDirectories.size,
      diagnosticPort: this.#server?.port ?? null,
    })
  }
  /** Per-instance mutable browser/profile data belongs here, never in the shared prepared-host cache. */
  get instanceDirectory(): string {
    return this.#instance
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closed = true
    this.#controller.abort(new DevelopmentError('CLOSED', 'Development session is closing'))
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    for (const watcher of this.#watchers.values()) watcher.close()
    this.#watchers.clear()
    for (const waiter of this.#pending?.waiters ?? [])
      waiter.reject(new DevelopmentError('CLOSED', 'Development session is closing'))
    this.#pending = undefined
    this.#closePromise = (async () => {
      const start = performance.now()
      const stopped = await Promise.allSettled([
        Promise.resolve().then(() => this.#options.shutdown()),
        this.#running,
        this.#server?.stop(true),
      ])
      if (stopped.some((item) => item.status === 'rejected')) {
        this.#restart(
          'Runtime shutdown was not confirmed; retained artifacts and instance ownership remain for diagnosis'
        )
        throw new DevelopmentError(
          'RESTART_REQUIRED',
          'Development shutdown did not establish resource release'
        )
      }
      await rm(this.#instance, { recursive: true, force: true })
      this.#retainedDirectories.clear()
      this.#dependencies.clear()
      this.#server = undefined
      this.#diagnostic(
        'closed',
        'shutdown',
        performance.now() - start,
        'CLOSED',
        'Watchers, generation artifacts and the owned runtime are closed'
      )
    })()
    return this.#closePromise
  }
}
