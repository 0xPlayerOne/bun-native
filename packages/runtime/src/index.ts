import {
  filesystemRootArgument,
  fileResultAnswers,
  parseFilesystemRoots,
  parseProcessExecutables,
  processArguments,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  ProtocolError,
  type Command,
  type NativeEvent,
  type ErrorCode,
  type Limits,
  type ServicePolicy,
  type Capability,
  type FileAccess,
  type HostEvent,
} from '@bun-native/protocol'
import { isAbsolute } from 'node:path'
import type { ReadableStreamDefaultReader } from 'node:stream/web'
import { exitDiagnostic, NativeHostExitError } from './exit-diagnostic.ts'
import { StartupTrace } from './startup-trace.ts'

export {
  MAX_DIAGNOSTIC_TAIL,
  NativeHostExitError,
  type NativeHostExitDiagnostic,
  type NativeHostExitReason,
} from './exit-diagnostic.ts'
export { installedRelease, reportHealthy, type InstalledRelease } from './installation.ts'
export type { ApplicationEvent, HostEvent, WindowEvent } from '@bun-native/protocol'

type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never
export type WindowCommand = WithoutId<
  Extract<
    Command,
    {
      type:
        | 'open'
        | 'batch'
        | 'close'
        | 'display_snapshot'
        | 'clipboard_read'
        | 'clipboard_write'
        | 'register_global_shortcut'
        | 'unregister_global_shortcut'
        | 'post_notification'
        | 'withdraw_notification'
        | 'open_file_grant'
        | 'close_file_grant'
        | 'file_request'
        | 'spawn_process'
        | 'write_process'
        | 'close_process_input'
        | 'resize_process'
        | 'signal_process'
        | 'acknowledge_process_output'
        | 'release_process'
        | 'show_file_dialog'
        | 'close_file_dialog'
        | 'show_message_dialog'
        | 'close_message_dialog'
        | 'show_context_menu'
        | 'close_context_menu'
        | 'register_drop_target'
        | 'unregister_drop_target'
        | 'resolve_dropped_item'
        | 'set_app_menu'
    }
  >
>
export type HostResponse = Extract<
  NativeEvent,
  {
    type:
      | 'ack'
      | 'opened'
      | 'applied'
      | 'display_snapshot'
      | 'clipboard_text'
      | 'clipboard_written'
      | 'global_shortcut_registered'
      | 'global_shortcut_unregistered'
      | 'notification_posted'
      | 'notification_withdrawn'
      | 'file_grant_opened'
      | 'file_grant_closed'
      | 'file_result'
      | 'process_spawned'
      | 'process_updated'
      | 'process_released'
      | 'file_dialog_opened'
      | 'file_dialog_closed'
      | 'message_dialog_opened'
      | 'message_dialog_closed'
      | 'context_menu_opened'
      | 'context_menu_closed'
      | 'drop_target_registered'
      | 'drop_target_unregistered'
      | 'dropped_item_resolved'
      | 'app_menu_set'
  }
>

export interface ProcessLimitPermissions {
  /** CPU seconds before the child is stopped (SIGXCPU on POSIX). */
  readonly cpuSeconds?: number
  /** Address space (Linux) or committed memory (Windows) in bytes. */
  readonly memoryBytes?: number
  /** Open descriptors (POSIX only). */
  readonly openFiles?: number
}

export interface ServicePermissions {
  /** Default deny. Fixed for the native process lifetime; no wire request can grant it. */
  readonly windowDisplay?: 'allow' | 'deny'
  readonly clipboardRead?: 'allow' | 'deny'
  readonly clipboardWrite?: 'allow' | 'deny'
  /** OS-wide key grabs that deliver while another application is focused. */
  readonly globalShortcuts?: 'allow' | 'deny'
  /** Desktop notifications posted by an owned window. */
  readonly notifications?: 'allow' | 'deny'
  /** Owned drop targets that receive external file drops as untrusted names. */
  readonly dragDrop?: 'allow' | 'deny'
  /**
   * Directories an owned window may open as scoped file grants. Each `path`
   * is absolute and normalized; `access` caps every grant on that root.
   */
  readonly filesystemRoots?: readonly Readonly<{ id: string; path: string; access: FileAccess }>[]
  /**
   * Executables an owned window may start as child processes, by ID. Each
   * `executable` is an absolute normalized path; nothing else can be started.
   * Optional `limits` apply to every child started from that entry; a
   * platform that cannot enforce one refuses the spawn with
   * `service_unavailable` (macOS has no memory limit, Windows no open-files
   * limit).
   */
  readonly processes?: readonly Readonly<{
    id: string
    executable: string
    limits?: Readonly<ProcessLimitPermissions>
  }>[]
  /** OS file open/save/folder dialogs owned by a window. Paths are data, never grants. */
  readonly fileDialogs?: 'allow' | 'deny'
  /** The application menu bar (macOS). Selections are reported as item IDs. */
  readonly appMenu?: 'allow' | 'deny'
  /** OS message dialogs (Windows task dialogs, macOS alert sheets) instead of the in-window overlay. */
  readonly taskDialogs?: 'allow' | 'deny'
}

export class NativeCommandError extends Error {
  override readonly name = 'NativeCommandError'
  constructor(
    readonly code: ErrorCode,
    readonly requestId: number,
    message: string
  ) {
    super('Native ' + code + ': ' + message)
  }
}

export interface HostOptions {
  /** Explicit prebuilt executable; starting an app never invokes Cargo. */
  executable: string
  /** Optional native process arguments, passed without a shell. */
  args?: readonly string[]
  requestTimeoutMs?: number
  permissions?: ServicePermissions
}

function launchPolicy(value: unknown = {}): Readonly<ServicePolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Native permissions must be an object')
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'windowDisplay',
          'clipboardRead',
          'clipboardWrite',
          'globalShortcuts',
          'notifications',
          'dragDrop',
          'filesystemRoots',
          'processes',
          'fileDialogs',
          'appMenu',
          'taskDialogs',
        ].includes(key)
    )
  )
    throw new TypeError('Unknown native service permission')
  const grant = (key: keyof ServicePermissions) => {
    const permission = Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : 'deny'
    if (permission !== 'allow' && permission !== 'deny')
      throw new TypeError(key + ' permission must be allow or deny')
    return permission === 'allow'
  }
  return Object.freeze({
    window_display: grant('windowDisplay'),
    clipboard_read: grant('clipboardRead'),
    clipboard_write: grant('clipboardWrite'),
    global_shortcuts: grant('globalShortcuts'),
    notifications: grant('notifications'),
    drag_drop: grant('dragDrop'),
    filesystem_roots: filesystemRoots(value),
    processes: processes(value),
    file_dialogs: grant('fileDialogs'),
    app_menu: grant('appMenu'),
    task_dialogs: grant('taskDialogs'),
  })
}

function processes(value: object): ServicePolicy['processes'] {
  const entries = Object.hasOwn(value, 'processes')
    ? (value as Record<string, unknown>)['processes']
    : []
  try {
    return Object.freeze(
      parseProcessExecutables(wireProcesses(entries)).map((entry) =>
        Object.freeze(entry.limits ? { ...entry, limits: Object.freeze(entry.limits) } : entry)
      )
    ) as ServicePolicy['processes']
  } catch (error) {
    throw new TypeError(
      'processes must list at most 8 unique { id, executable, limits? } entries: ' +
        (error as Error).message
    )
  }
}

const LIMIT_WIRE_NAMES = {
  cpuSeconds: 'cpu_seconds',
  memoryBytes: 'memory_bytes',
  openFiles: 'open_files',
} as const

/** Public camelCase limits become the wire's snake_case; anything else is left for the parser to reject. */
function wireProcesses(entries: unknown): unknown {
  if (!Array.isArray(entries)) return entries
  return entries.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'limits')) return entry
    const { limits, ...rest } = entry as { limits: unknown }
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return { ...rest, limits }
    return {
      ...rest,
      limits: Object.fromEntries(
        Object.entries(limits).map(([name, value]) => [
          Object.hasOwn(LIMIT_WIRE_NAMES, name)
            ? LIMIT_WIRE_NAMES[name as keyof typeof LIMIT_WIRE_NAMES]
            : name,
          value,
        ])
      ),
    }
  })
}

function filesystemRoots(value: object): ServicePolicy['filesystem_roots'] {
  const roots = Object.hasOwn(value, 'filesystemRoots')
    ? (value as Record<string, unknown>)['filesystemRoots']
    : []
  try {
    return Object.freeze(
      parseFilesystemRoots(roots).map((root) => Object.freeze(root))
    ) as ServicePolicy['filesystem_roots']
  } catch (error) {
    throw new TypeError(
      'filesystemRoots must list at most 8 unique { id, path, access } roots: ' +
        (error as Error).message
    )
  }
}

function samePolicy(left: Readonly<ServicePolicy>, right: Readonly<ServicePolicy>): boolean {
  return (
    left.window_display === right.window_display &&
    left.clipboard_read === right.clipboard_read &&
    left.clipboard_write === right.clipboard_write &&
    left.global_shortcuts === right.global_shortcuts &&
    left.notifications === right.notifications &&
    (left.file_dialogs ?? false) === (right.file_dialogs ?? false) &&
    (left.app_menu ?? false) === (right.app_menu ?? false) &&
    (left.task_dialogs ?? false) === (right.task_dialogs ?? false) &&
    left.drag_drop === right.drag_drop &&
    left.filesystem_roots.length === right.filesystem_roots.length &&
    left.filesystem_roots.every(
      (root, index) =>
        root.id === right.filesystem_roots[index]!.id &&
        root.path === right.filesystem_roots[index]!.path &&
        root.access === right.filesystem_roots[index]!.access
    ) &&
    left.processes.length === right.processes.length &&
    left.processes.every(
      (entry, index) =>
        entry.id === right.processes[index]!.id &&
        entry.executable === right.processes[index]!.executable &&
        entry.limits?.cpu_seconds === right.processes[index]!.limits?.cpu_seconds &&
        entry.limits?.memory_bytes === right.processes[index]!.limits?.memory_bytes &&
        entry.limits?.open_files === right.processes[index]!.limits?.open_files
    )
  )
}

type Pending = {
  command: Command
  resolve: (response: HostResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Diagnostic only: when the serialized stdin write and flush of one request settled. */
type RequestWrite = { readonly queuedAt: number; writtenAt?: number; flushedAt?: number }

function describeWrite(write: RequestWrite): string {
  const at = (time: number) => '+' + Math.round(time - write.queuedAt) + 'ms'
  const state =
    write.flushedAt !== undefined ? 'flushed' : write.writtenAt !== undefined ? 'written' : 'queued'
  return (
    `write ${state}: queued +0ms` +
    (write.writtenAt === undefined ? '' : ', written ' + at(write.writtenAt)) +
    (write.flushedAt === undefined ? '' : ', flushed ' + at(write.flushedAt))
  )
}

type WaitingReader = {
  resolve: (value: IteratorResult<HostEvent>) => void
  reject: (error: Error) => void
}

const MAX_PENDING_COMMANDS = 128
const MAX_QUEUED_EVENTS = 128

/**
 * Owns one native process and its bounded, versioned channel. Private transport;
 * framework-specific reconciliation belongs above this shared connection.
 */
export class NativeHost implements AsyncIterable<HostEvent> {
  readonly exited: Promise<number>
  private readonly process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private readonly stdout: ReadableStreamDefaultReader<Uint8Array>
  private readonly stderr: ReadableStreamDefaultReader<Uint8Array>
  private readonly timeout: number
  private readonly pending = new Map<number, Pending>()
  private readonly events: HostEvent[] = []
  private readonly finished: Promise<void>
  private waiting: WaitingReader | undefined
  /** Queued events the consumer has taken; progress while reading is paused. */
  private taken = 0
  private failure: Error | undefined
  private phase: 'starting' | 'running' | 'stopping' | 'closed' = 'starting'
  private ready = false
  private negotiatedLimits: Readonly<Limits> | undefined
  private negotiatedServicePolicy: Readonly<ServicePolicy> | undefined
  private negotiatedCapabilities: readonly Capability[] | undefined
  private sequence = 0
  private nextId = 1
  private writeTail: Promise<void> = Promise.resolve()
  private stderrTail = ''
  private stderrClipped = false
  private stderrPanic: string | null = null
  private iteratorTaken = false
  private readonly startupTrace = StartupTrace.fromEnvironment()

  private constructor(
    options: HostOptions,
    private readonly requestedPolicy: Readonly<ServicePolicy>
  ) {
    this.timeout = options.requestTimeoutMs ?? 5_000
    this.process = Bun.spawn({
      cmd: [
        options.executable,
        ...(options.args ?? []),
        ...(requestedPolicy.window_display ? ['--bun-native-allow-window-display'] : []),
        ...(requestedPolicy.clipboard_read ? ['--bun-native-allow-clipboard-read'] : []),
        ...(requestedPolicy.clipboard_write ? ['--bun-native-allow-clipboard-write'] : []),
        ...(requestedPolicy.global_shortcuts ? ['--bun-native-allow-global-shortcuts'] : []),
        ...(requestedPolicy.notifications ? ['--bun-native-allow-notifications'] : []),
        ...(requestedPolicy.drag_drop ? ['--bun-native-allow-drag-drop'] : []),
        ...requestedPolicy.filesystem_roots.map(filesystemRootArgument),
        ...requestedPolicy.processes.flatMap(processArguments),
        ...(requestedPolicy.file_dialogs ? ['--bun-native-allow-file-dialogs'] : []),
        ...(requestedPolicy.app_menu ? ['--bun-native-allow-app-menu'] : []),
        ...(requestedPolicy.task_dialogs ? ['--bun-native-allow-task-dialogs'] : []),
      ],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      // A terminal's Ctrl-C signals its whole foreground process group. The
      // application owns the host's lifetime and ends it through `shutdown`
      // (or closed stdin), so the host runs in its own session on POSIX.
      detached: process.platform !== 'win32',
    })
    this.stdout = this.process.stdout.getReader()
    this.stderr = this.process.stderr.getReader()
    this.exited = this.process.exited
    this.finished = this.watch()
  }

  static async launch(options: HostOptions): Promise<NativeHost> {
    if (!isAbsolute(options.executable)) throw new Error('Native host path must be absolute')
    const timeout = options.requestTimeoutMs ?? 5_000
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
      throw new Error('requestTimeoutMs must be an integer between 1 and 60000')
    const policy = launchPolicy(options.permissions)
    if (
      options.args?.some(
        (argument) => typeof argument !== 'string' || argument.startsWith('--bun-native-')
      )
    )
      throw new TypeError(
        'Native service arguments are reserved for the explicit permissions option'
      )
    const host = new NativeHost(options, policy)
    try {
      await host.request({ type: 'hello', protocol: PROTOCOL_VERSION })
      if (!host.ready) throw new ProtocolError('Host acknowledged hello before protocol readiness')
      host.phase = 'running'
      return host
    } catch (error) {
      host.fail(error)
      await host.finished
      throw host.failure
    }
  }

  /** Whether the transport is still open (false once it failed or shut down). */
  get running(): boolean {
    return this.phase === 'running'
  }

  get limits(): Readonly<Limits> {
    if (!this.negotiatedLimits) throw new ProtocolError('Native limits are not negotiated')
    return this.negotiatedLimits
  }

  get servicePolicy(): Readonly<ServicePolicy> {
    if (!this.negotiatedServicePolicy)
      throw new ProtocolError('Native service policy is not negotiated')
    return this.negotiatedServicePolicy
  }

  get capabilities(): readonly Capability[] {
    if (!this.negotiatedCapabilities)
      throw new ProtocolError('Native capabilities are not negotiated')
    return this.negotiatedCapabilities
  }

  /** Resolves after the native UI thread acknowledges the operation. */
  send(
    command: Extract<WindowCommand, { type: 'open' }>
  ): Promise<Extract<HostResponse, { type: 'opened' }>>
  send(
    command: Extract<WindowCommand, { type: 'batch' }>
  ): Promise<Extract<HostResponse, { type: 'applied' }>>
  send(
    command: Extract<WindowCommand, { type: 'close' }>
  ): Promise<Extract<HostResponse, { type: 'ack' }>>
  send(
    command: Extract<WindowCommand, { type: 'display_snapshot' }>
  ): Promise<Extract<HostResponse, { type: 'display_snapshot' }>>
  send(
    command: Extract<WindowCommand, { type: 'clipboard_read' }>
  ): Promise<Extract<HostResponse, { type: 'clipboard_text' }>>
  send(
    command: Extract<WindowCommand, { type: 'clipboard_write' }>
  ): Promise<Extract<HostResponse, { type: 'clipboard_written' }>>
  send(
    command: Extract<WindowCommand, { type: 'register_global_shortcut' }>
  ): Promise<Extract<HostResponse, { type: 'global_shortcut_registered' }>>
  send(
    command: Extract<WindowCommand, { type: 'unregister_global_shortcut' }>
  ): Promise<Extract<HostResponse, { type: 'global_shortcut_unregistered' }>>
  send(
    command: Extract<WindowCommand, { type: 'post_notification' }>
  ): Promise<Extract<HostResponse, { type: 'notification_posted' }>>
  send(
    command: Extract<WindowCommand, { type: 'withdraw_notification' }>
  ): Promise<Extract<HostResponse, { type: 'notification_withdrawn' }>>
  send(
    command: Extract<WindowCommand, { type: 'open_file_grant' }>
  ): Promise<Extract<HostResponse, { type: 'file_grant_opened' }>>
  send(
    command: Extract<WindowCommand, { type: 'close_file_grant' }>
  ): Promise<Extract<HostResponse, { type: 'file_grant_closed' }>>
  send(
    command: Extract<WindowCommand, { type: 'file_request' }>
  ): Promise<Extract<HostResponse, { type: 'file_result' }>>
  send(
    command: Extract<WindowCommand, { type: 'spawn_process' }>
  ): Promise<Extract<HostResponse, { type: 'process_spawned' }>>
  send(
    command: Extract<WindowCommand, { type: 'release_process' }>
  ): Promise<Extract<HostResponse, { type: 'process_released' }>>
  send(
    command: Extract<
      WindowCommand,
      {
        type:
          | 'write_process'
          | 'close_process_input'
          | 'resize_process'
          | 'signal_process'
          | 'acknowledge_process_output'
      }
    >
  ): Promise<Extract<HostResponse, { type: 'process_updated' }>>
  send(
    command: Extract<WindowCommand, { type: 'show_file_dialog' }>
  ): Promise<Extract<HostResponse, { type: 'file_dialog_opened' }>>
  send(
    command: Extract<WindowCommand, { type: 'close_file_dialog' }>
  ): Promise<Extract<HostResponse, { type: 'file_dialog_closed' }>>
  send(
    command: Extract<WindowCommand, { type: 'show_message_dialog' }>
  ): Promise<Extract<HostResponse, { type: 'message_dialog_opened' }>>
  send(
    command: Extract<WindowCommand, { type: 'close_message_dialog' }>
  ): Promise<Extract<HostResponse, { type: 'message_dialog_closed' }>>
  send(
    command: Extract<WindowCommand, { type: 'show_context_menu' }>
  ): Promise<Extract<HostResponse, { type: 'context_menu_opened' }>>
  send(
    command: Extract<WindowCommand, { type: 'close_context_menu' }>
  ): Promise<Extract<HostResponse, { type: 'context_menu_closed' }>>
  send(
    command: Extract<WindowCommand, { type: 'register_drop_target' }>
  ): Promise<Extract<HostResponse, { type: 'drop_target_registered' }>>
  send(
    command: Extract<WindowCommand, { type: 'unregister_drop_target' }>
  ): Promise<Extract<HostResponse, { type: 'drop_target_unregistered' }>>
  send(
    command: Extract<WindowCommand, { type: 'resolve_dropped_item' }>
  ): Promise<Extract<HostResponse, { type: 'dropped_item_resolved' }>>
  send(
    command: Extract<WindowCommand, { type: 'set_app_menu' }>
  ): Promise<Extract<HostResponse, { type: 'app_menu_set' }>>
  send(command: WindowCommand): Promise<HostResponse>
  send(command: WindowCommand): Promise<HostResponse> {
    if (this.phase !== 'running') return Promise.reject(this.closedError())
    return this.request(command)
  }

  async shutdown(): Promise<void> {
    if (this.phase === 'closed' || this.phase === 'stopping') {
      await this.finished
      if (this.failure) throw this.failure
      return
    }
    this.phase = 'stopping'
    try {
      await this.request({ type: 'shutdown' })
      this.process.stdin.end()
      const deadline = setTimeout(
        () => this.fail(new Error('Native host did not exit')),
        this.timeout
      )
      try {
        await this.finished
      } finally {
        clearTimeout(deadline)
      }
      if (this.failure) throw this.failure
    } catch (error) {
      this.fail(error)
      await this.finished
      throw this.failure
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<HostEvent> {
    if (this.iteratorTaken) throw new Error('Native events have exactly one consumer')
    this.iteratorTaken = true
    return {
      next: () => {
        if (this.failure) return Promise.reject(this.failure)
        const event = this.events.shift()
        if (event) {
          this.taken += 1
          return Promise.resolve({ done: false, value: event })
        }
        if (this.phase === 'closed') return Promise.resolve({ done: true, value: undefined })
        if (this.waiting)
          return Promise.reject(new Error('Concurrent event reads are not supported'))
        return new Promise<IteratorResult<HostEvent>>((resolve, reject) => {
          this.waiting = { resolve, reject }
        })
      },
      return: async () => {
        await this.shutdown()
        return { done: true, value: undefined }
      },
    }
  }

  private request(input: WithoutId<Command>): Promise<HostResponse> {
    if (this.phase === 'closed') return Promise.reject(this.closedError())
    if (this.pending.size >= MAX_PENDING_COMMANDS)
      return Promise.reject(new Error('Native command limit exceeded'))
    let command: Command
    let frame: Uint8Array
    try {
      command = parseCommand({ ...input, id: this.nextId++ })
      frame = encodeFrame(command)
      if (this.negotiatedLimits) {
        if (frame.byteLength - 1 > this.negotiatedLimits.max_frame_bytes)
          throw new ProtocolError('Command exceeds the negotiated frame limit')
        if (
          command.type === 'batch' &&
          command.operations.length > this.negotiatedLimits.max_operations
        )
          throw new ProtocolError('Command exceeds the negotiated batch limit')
        if (
          command.type === 'clipboard_write' &&
          Buffer.byteLength(command.text, 'utf8') > this.negotiatedLimits.max_clipboard_bytes
        )
          throw new ProtocolError('Clipboard write exceeds the negotiated text limit')
        const chunk = this.negotiatedLimits.max_file_chunk_bytes
        if (
          command.type === 'file_request' &&
          ((command.operation.kind === 'read' && command.operation.length > chunk) ||
            (command.operation.kind === 'write' &&
              Buffer.from(command.operation.data, 'base64').byteLength > chunk))
        )
          throw new ProtocolError('File request exceeds the negotiated chunk limit')
      }
    } catch (error) {
      return Promise.reject(error)
    }
    const write: RequestWrite = { queuedAt: performance.now() }
    const result = new Promise<HostResponse>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            new Error(
              `Native ${command.type} request ${command.id} timed out (${describeWrite(write)})`
            )
          ),
        this.timeout
      )
      this.pending.set(command.id, {
        command,
        resolve,
        reject,
        timer,
      })
    })
    this.startupTrace?.request('request_queued', command, this.process.pid)
    // FileSink buffering is bounded by the pending-command cap and frame limit.
    this.writeTail = this.writeTail
      .then(async () => {
        if (this.phase === 'closed') return
        this.startupTrace?.request('stdin_write_enter', command, this.process.pid)
        this.process.stdin.write(frame)
        write.writtenAt = performance.now()
        this.startupTrace?.request('stdin_write_returned', command, this.process.pid)
        this.startupTrace?.request('stdin_flush_enter', command, this.process.pid)
        await this.process.stdin.flush()
        write.flushedAt = performance.now()
        this.startupTrace?.request('stdin_flushed', command, this.process.pid)
      })
      .catch((error: unknown) => this.fail(error))
    return result
  }

  private async readStdout(): Promise<void> {
    const decoder = new FrameDecoder()
    try {
      for (;;) {
        const { done, value } = await this.stdout.read()
        if (done) break
        for (const raw of decoder.push(value)) this.receive(parseEvent(raw))
        if (this.events.length >= MAX_QUEUED_EVENTS) await this.drainEvents()
      }
      decoder.finish()
      if (
        this.phase !== 'stopping' &&
        this.phase !== 'closed' &&
        !(await this.exitsWithinTimeout())
      )
        throw new ProtocolError('Native output closed before shutdown')
    } finally {
      this.stdout.releaseLock()
    }
  }

  /**
   * One pipe read can coalesce more frames than the cap while the consumer is
   * keeping up. Over the cap, reading pauses for macrotask turns while the
   * consumer takes events, and fails only a turn in which it took none, so
   * queued events stay bounded by the cap plus one read.
   */
  private async drainEvents(): Promise<void> {
    while (this.events.length >= MAX_QUEUED_EVENTS) {
      const taken = this.taken
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (this.phase === 'closed') return
      if (this.taken === taken) throw new ProtocolError('Native event limit exceeded')
    }
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await this.stderr.read()
        if (done) break
        this.appendStderr(decoder.decode(value, { stream: true }))
      }
      this.appendStderr(decoder.decode())
    } finally {
      this.stderr.releaseLock()
    }
  }

  private appendStderr(text: string): void {
    const tail = this.stderrTail + text
    // Keep the first complete panic header and message line: a long backtrace
    // can push them out of the bounded tail before the host exits.
    if (this.stderrPanic === null) {
      const panic = /(^|\n)([^\n]*panicked at [^\n]*\n[^\n]*)\n/.exec(tail)
      if (panic && (panic[1] || !this.stderrClipped)) this.stderrPanic = panic[2]!
    }
    if (tail.length > 4_096) this.stderrClipped = true
    this.stderrTail = tail.slice(-4_096)
  }

  /**
   * Unexpected EOF usually precedes the exit status of a crashed host. Wait for
   * that status, bounded, so the failure can carry its exit diagnostic.
   */
  private async exitsWithinTimeout(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.timeout)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private exitError(status: number): NativeHostExitError {
    const phase = this.phase === 'closed' ? 'running' : this.phase
    return new NativeHostExitError(
      exitDiagnostic({
        exitCode: this.process.exitCode,
        signal: this.process.signalCode === null ? null : String(this.process.signalCode),
        phase,
        pendingRequests: this.pending.size,
        stderr: this.stderrTail,
        stderrClipped: this.stderrClipped,
        panicReport: this.stderrPanic,
        environment: process.env,
      }),
      status
    )
  }

  private cancelOutput(): void {
    // The host can exit while another process still holds inherited pipe ends.
    // Cancel our reads directly; killing the already-exited host cannot close them.
    void this.stdout.cancel().catch(() => {})
    void this.stderr.cancel().catch(() => {})
  }

  private async watch(): Promise<void> {
    const streams = [this.readStdout(), this.readStderr()]
    let drainDeadline: ReturnType<typeof setTimeout> | undefined
    const exit = this.exited.then((code) => {
      // Allow buffered acknowledgements/diagnostics to drain, but bound EOF wait.
      drainDeadline = setTimeout(
        () => this.fail(new Error('Native output remained open after host exit')),
        this.timeout
      )
      return code
    })
    try {
      const [code] = await Promise.all([exit, ...streams])
      if (code !== 0 || this.phase !== 'stopping' || this.pending.size) throw this.exitError(code)
      this.phase = 'closed'
      this.waiting?.resolve({ done: true, value: undefined })
      this.waiting = undefined
    } catch (error) {
      this.fail(error)
      await this.exited
    } finally {
      clearTimeout(drainDeadline)
      this.cancelOutput()
      await Promise.allSettled(streams)
      this.startupTrace?.finished(this.process.exitCode, this.stderrTail, this.process.pid)
    }
  }

  private receive(event: NativeEvent): void {
    if (this.phase === 'closed') return
    this.startupTrace?.response(event, this.process.pid)
    if (
      event.type === 'clipboard_text' &&
      event.result.kind === 'text' &&
      this.negotiatedLimits &&
      Buffer.byteLength(event.result.text, 'utf8') > this.negotiatedLimits.max_clipboard_bytes
    )
      throw new ProtocolError('Clipboard response exceeds the negotiated text limit')
    if (
      event.type === 'file_result' &&
      event.result.kind === 'read' &&
      this.negotiatedLimits &&
      Buffer.from(event.result.data, 'base64').byteLength >
        this.negotiatedLimits.max_file_chunk_bytes
    )
      throw new ProtocolError('File read exceeds the negotiated chunk limit')
    if (event.type === 'ready') {
      if (this.ready || this.phase !== 'starting') throw new ProtocolError('Unexpected ready event')
      if (REQUIRED_CAPABILITIES.some((capability) => !event.capabilities.includes(capability)))
        throw new ProtocolError(
          'Native host lacks required protocol capabilities: ' + REQUIRED_CAPABILITIES.join(', ')
        )
      this.negotiatedLimits = Object.freeze(event.limits)
      if (!samePolicy(event.service_policy, this.requestedPolicy))
        throw new ProtocolError(
          'Native service policy does not match the explicit launch permissions'
        )
      this.negotiatedServicePolicy = this.requestedPolicy
      this.negotiatedCapabilities = Object.freeze(event.capabilities)
      this.ready = true
      return
    }
    if (
      event.type === 'ack' ||
      event.type === 'opened' ||
      event.type === 'applied' ||
      event.type === 'display_snapshot' ||
      event.type === 'clipboard_text' ||
      event.type === 'clipboard_written' ||
      event.type === 'global_shortcut_registered' ||
      event.type === 'global_shortcut_unregistered' ||
      event.type === 'notification_posted' ||
      event.type === 'notification_withdrawn' ||
      event.type === 'file_grant_opened' ||
      event.type === 'file_grant_closed' ||
      event.type === 'file_result' ||
      event.type === 'process_spawned' ||
      event.type === 'process_updated' ||
      event.type === 'process_released' ||
      event.type === 'file_dialog_opened' ||
      event.type === 'file_dialog_closed' ||
      event.type === 'message_dialog_opened' ||
      event.type === 'message_dialog_closed' ||
      event.type === 'context_menu_opened' ||
      event.type === 'context_menu_closed' ||
      event.type === 'drop_target_registered' ||
      event.type === 'drop_target_unregistered' ||
      event.type === 'dropped_item_resolved' ||
      event.type === 'app_menu_set' ||
      event.type === 'error'
    ) {
      if (event.type === 'error' && event.id === undefined)
        throw new ProtocolError(`Native ${event.code}: ${event.message}`)
      const requestId = event.id
      const request = requestId === undefined ? undefined : this.pending.get(requestId)
      if (!request || requestId === undefined) throw new ProtocolError('Unknown native response id')
      clearTimeout(request.timer)
      this.pending.delete(requestId)
      if (event.type === 'error')
        request.reject(new NativeCommandError(event.code, requestId, event.message))
      else if (!this.matchesResponse(request.command, event)) {
        const error = new ProtocolError(
          'Native response does not match its request, owner or revision'
        )
        request.reject(error)
        throw error
      } else request.resolve(event)
      return
    }
    if (!this.ready) throw new ProtocolError('Native input arrived before protocol readiness')
    if (event.sequence !== this.sequence + 1)
      throw new ProtocolError('Native event sequence is out of order')
    this.sequence = event.sequence
    if (this.waiting) {
      this.waiting.resolve({ done: false, value: event })
      this.waiting = undefined
    } else {
      this.events.push(event)
    }
  }

  private matchesResponse(command: Command, response: HostResponse): boolean {
    switch (command.type) {
      case 'display_snapshot':
        return response.type === 'display_snapshot' && response.window_id === command.window_id
      case 'clipboard_read':
        return response.type === 'clipboard_text' && response.window_id === command.window_id
      case 'clipboard_write':
        return response.type === 'clipboard_written' && response.window_id === command.window_id
      case 'register_global_shortcut':
        return (
          response.type === 'global_shortcut_registered' &&
          response.window_id === command.window_id &&
          response.shortcut_id === command.shortcut_id
        )
      case 'unregister_global_shortcut':
        return (
          response.type === 'global_shortcut_unregistered' &&
          response.window_id === command.window_id &&
          response.shortcut_id === command.shortcut_id
        )
      case 'post_notification':
        return (
          response.type === 'notification_posted' &&
          response.window_id === command.window_id &&
          response.notification_id === command.notification_id
        )
      case 'withdraw_notification':
        return (
          response.type === 'notification_withdrawn' &&
          response.window_id === command.window_id &&
          response.notification_id === command.notification_id
        )
      case 'open_file_grant':
      case 'close_file_grant':
        return (
          response.type ===
            (command.type === 'open_file_grant' ? 'file_grant_opened' : 'file_grant_closed') &&
          response.window_id === command.window_id &&
          response.grant_id === command.grant_id
        )
      case 'file_request':
        return (
          response.type === 'file_result' &&
          response.window_id === command.window_id &&
          response.grant_id === command.grant_id &&
          fileResultAnswers(command.operation, response.result)
        )
      case 'spawn_process':
      case 'write_process':
      case 'close_process_input':
      case 'resize_process':
      case 'signal_process':
      case 'acknowledge_process_output':
      case 'release_process':
        return (
          response.type ===
            (command.type === 'spawn_process'
              ? 'process_spawned'
              : command.type === 'release_process'
                ? 'process_released'
                : 'process_updated') &&
          response.window_id === command.window_id &&
          response.process_id === command.process_id
        )
      case 'show_file_dialog':
        return (
          response.type === 'file_dialog_opened' &&
          response.window_id === command.window_id &&
          response.dialog_id === command.dialog_id
        )
      case 'close_file_dialog':
        return (
          response.type === 'file_dialog_closed' &&
          response.window_id === command.window_id &&
          response.dialog_id === command.dialog_id
        )
      case 'show_message_dialog':
        return (
          response.type === 'message_dialog_opened' &&
          response.window_id === command.window_id &&
          response.dialog_id === command.dialog_id
        )
      case 'close_message_dialog':
        return (
          response.type === 'message_dialog_closed' &&
          response.window_id === command.window_id &&
          response.dialog_id === command.dialog_id
        )
      case 'show_context_menu':
      case 'close_context_menu':
        return (
          response.type ===
            (command.type === 'show_context_menu'
              ? 'context_menu_opened'
              : 'context_menu_closed') &&
          response.window_id === command.window_id &&
          response.menu_id === command.menu_id
        )
      case 'register_drop_target':
      case 'unregister_drop_target':
        return (
          response.type ===
            (command.type === 'register_drop_target'
              ? 'drop_target_registered'
              : 'drop_target_unregistered') &&
          response.window_id === command.window_id &&
          response.target_id === command.target_id
        )
      case 'resolve_dropped_item':
        return (
          response.type === 'dropped_item_resolved' &&
          response.window_id === command.window_id &&
          response.target_id === command.target_id &&
          response.drop_id === command.drop_id &&
          response.item === command.item &&
          response.root === command.root
        )
      case 'set_app_menu':
        return response.type === 'app_menu_set' && response.menu_id === command.menu_id
      case 'open':
        return (
          response.type === 'opened' &&
          response.window_id === command.window_id &&
          response.root_id === command.root_id &&
          response.tree_revision === 0
        )
      case 'batch':
        return (
          response.type === 'applied' &&
          response.window_id === command.window_id &&
          response.tree_revision === command.base_revision + 1
        )
      case 'hello':
      case 'close':
      case 'shutdown':
        return response.type === 'ack'
    }
  }

  private closedError(): Error {
    return this.failure ?? new Error('Native host is not running')
  }

  private fail(cause: unknown): void {
    if (this.failure) return
    this.failure = cause instanceof Error ? cause : new Error(String(cause))
    this.startupTrace?.failure(this.failure, this.stderrTail, this.process.pid)
    this.phase = 'closed'
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(this.failure)
    }
    this.pending.clear()
    this.events.length = 0
    this.waiting?.reject(this.failure)
    this.waiting = undefined
    this.cancelOutput()
    this.process.kill('SIGKILL')
  }
}
