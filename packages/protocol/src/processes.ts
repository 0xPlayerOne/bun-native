import { ProtocolError } from './framing.ts'
import { parseChunk, parseFilePath, parseRootId, parseRootPath } from './files.ts'
import { fields, id, integer, keys, object } from './values.ts'

export const MAX_PROCESS_EXECUTABLES = 8
export const MAX_PROCESSES = 8
export const MAX_PROCESS_ARGS = 64
export const MAX_PROCESS_ENV = 64
export const MAX_PROCESS_OUTPUT_CREDIT = 4
const MAX_PROCESS_ARG_BYTES = 4_096
const MAX_PROCESS_ENV_NAME_BYTES = 128
const MAX_PROCESS_ENV_VALUE_BYTES = 4_096
const MAX_PROCESS_LAUNCH_BYTES = 32_768
const MAX_TERMINAL_DIMENSION = 1_000
const PROCESS_ARGUMENT = '--bun-native-process='
const PROCESS_LIMITS_ARGUMENT = '--bun-native-process-limits='
const MAX_PROCESS_CPU_SECONDS = 604_800
const MIN_PROCESS_MEMORY_BYTES = 2 ** 20
const MAX_PROCESS_MEMORY_BYTES = 2 ** 48
const MIN_PROCESS_OPEN_FILES = 3
const MAX_PROCESS_OPEN_FILES = 2 ** 20
const encoder = new TextEncoder()
const bytes = (value: string) => encoder.encode(value).byteLength

/**
 * Resource limits every child started from one executable entry runs under.
 * A platform that cannot enforce a requested limit refuses the spawn.
 */
export interface ProcessLimits {
  /** CPU time (POSIX `RLIMIT_CPU`, Windows per-process job time). */
  cpu_seconds?: number
  /** Memory (Linux `RLIMIT_AS`, Windows per-process job memory). */
  memory_bytes?: number
  /** Open descriptors (POSIX `RLIMIT_NOFILE`). */
  open_files?: number
}

export interface ProcessExecutable {
  id: string
  executable: string
  limits?: ProcessLimits
}

const LIMIT_NAMES = ['cpu_seconds', 'memory_bytes', 'open_files'] as const
const LIMIT_BOUNDS = {
  cpu_seconds: [1, MAX_PROCESS_CPU_SECONDS],
  memory_bytes: [MIN_PROCESS_MEMORY_BYTES, MAX_PROCESS_MEMORY_BYTES],
  open_files: [MIN_PROCESS_OPEN_FILES, MAX_PROCESS_OPEN_FILES],
} as const

const PROCESS_LIMITS_KEYS = fields(...LIMIT_NAMES)

function parseProcessLimits(value: unknown): ProcessLimits {
  const data = object(value)
  keys(data, PROCESS_LIMITS_KEYS)
  const limits: ProcessLimits = {}
  for (const name of LIMIT_NAMES)
    if (name in data) {
      const [min, max] = LIMIT_BOUNDS[name]
      limits[name] = integer(data[name], 'process ' + name, min, max)
    }
  if (Object.keys(limits).length === 0)
    throw new ProtocolError('Process limits must set at least one limit')
  return limits
}

/** `cpu_seconds=N,memory_bytes=N,open_files=N`, only the set limits, in that order. */
export function processLimitsArgument(limits: ProcessLimits): string {
  const parsed = parseProcessLimits(limits)
  return LIMIT_NAMES.filter((name) => parsed[name] !== undefined)
    .map((name) => name + '=' + parsed[name])
    .join(',')
}

/** Parses `processLimitsArgument`'s form strictly, as the native host does. */
export function parseProcessLimitsArgument(text: string): ProcessLimits {
  const data: Record<string, number> = {}
  let last = -1
  for (const part of text.split(',')) {
    const match = /^([a-z_]+)=(0|[1-9][0-9]{0,19})$/.exec(part)
    const order = LIMIT_NAMES.indexOf(match?.[1] as (typeof LIMIT_NAMES)[number])
    if (!match || order <= last)
      throw new ProtocolError('Process limits must be cpu_seconds=N,memory_bytes=N,open_files=N')
    last = order
    data[match[1]!] = Number(match[2])
  }
  return parseProcessLimits(data)
}

export interface TerminalSize {
  columns: number
  rows: number
}

export interface ProcessLaunch {
  executable: string
  args: string[]
  env: Record<string, string>
  cwd?: { grant_id: number; path: string }
  terminal?: TerminalSize
}

export const PROCESS_SIGNALS = Object.freeze(['interrupt', 'terminate', 'kill', 'hangup'] as const)
export type ProcessSignal = (typeof PROCESS_SIGNALS)[number]
export type ProcessStream = 'stdout' | 'stderr' | 'terminal'
export type ProcessExit = { code: number } | { signal: number }

const EXECUTABLE_KEYS = fields('id', 'executable', 'limits')

function executable(value: unknown): ProcessExecutable {
  const data = object(value)
  keys(data, EXECUTABLE_KEYS)
  const path = parseRootPath(data['executable'])
  // `/` and `X:\` are the only normalized paths ending in a separator.
  if (path.endsWith('/') || path.endsWith('\\'))
    throw new ProtocolError('Process executable must name a file')
  const entry: ProcessExecutable = { id: parseRootId(data['id']), executable: path }
  if ('limits' in data) entry.limits = parseProcessLimits(data['limits'])
  return entry
}

export function parseProcessExecutables(value: unknown): ProcessExecutable[] {
  if (!Array.isArray(value) || value.length > MAX_PROCESS_EXECUTABLES)
    throw new ProtocolError(
      'At most ' + MAX_PROCESS_EXECUTABLES + ' process executables may be granted'
    )
  const entries = value.map(executable)
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new ProtocolError('Process executable IDs must be unique')
  return entries
}

/**
 * The reserved native launch arguments for one validated executable: the
 * executable itself, then its limits when it has any.
 */
export function processArguments(value: ProcessExecutable): string[] {
  const entry = executable(value)
  const argv = [PROCESS_ARGUMENT + entry.id + ':' + entry.executable]
  if (entry.limits)
    argv.push(PROCESS_LIMITS_ARGUMENT + entry.id + ':' + processLimitsArgument(entry.limits))
  return argv
}

export function processesFromArguments(argv: readonly string[]): ProcessExecutable[] {
  // One pass, as the host parses them: limits name an executable granted by
  // an earlier argument, at most once.
  const entries: ProcessExecutable[] = []
  for (const argument of argv) {
    if (argument.startsWith(PROCESS_ARGUMENT)) {
      const [entry, ...path] = argument.slice(PROCESS_ARGUMENT.length).split(':')
      entries.push({ id: entry!, executable: path.join(':') })
    } else if (argument.startsWith(PROCESS_LIMITS_ARGUMENT)) {
      const text = argument.slice(PROCESS_LIMITS_ARGUMENT.length)
      const separator = text.indexOf(':')
      const entry = entries.find((item) => item.id === text.slice(0, separator))
      if (separator < 0 || !entry || entry.limits)
        throw new ProtocolError('Process limits must name one granted executable once')
      entry.limits = parseProcessLimitsArgument(text.slice(separator + 1))
    }
  }
  return parseProcessExecutables(entries)
}

function plain(value: unknown, limit: number, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.includes('\0') ||
    bytes(value) > limit
  )
    throw new ProtocolError(field + ' must be a NUL-free string of at most ' + limit + ' bytes')
  return value
}

const TERMINAL_SIZE_KEYS = fields('columns', 'rows')

export function parseTerminalSize(value: unknown): TerminalSize {
  const data = object(value)
  keys(data, TERMINAL_SIZE_KEYS)
  return {
    columns: integer(data['columns'], 'terminal columns', 1, MAX_TERMINAL_DIMENSION),
    rows: integer(data['rows'], 'terminal rows', 1, MAX_TERMINAL_DIMENSION),
  }
}

function parseEnvName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || value.length > MAX_PROCESS_ENV_NAME_BYTES)
    throw new ProtocolError(
      'Environment names must be ASCII letters, digits and "_", not starting with a digit'
    )
  return value
}

const PROCESS_LAUNCH_KEYS = fields('executable', 'args', 'env', 'cwd', 'terminal')
const PROCESS_CWD_KEYS = fields('grant_id', 'path')

export function parseProcessLaunch(value: unknown): ProcessLaunch {
  const data = object(value)
  keys(data, PROCESS_LAUNCH_KEYS)
  const args = data['args']
  if (!Array.isArray(args) || args.length > MAX_PROCESS_ARGS)
    throw new ProtocolError('Process arguments must be an array of at most ' + MAX_PROCESS_ARGS)
  const parsedArgs = args.map((item) => plain(item, MAX_PROCESS_ARG_BYTES, 'Process argument'))
  const env = object(data['env'])
  const names = Object.keys(env)
  if (names.length > MAX_PROCESS_ENV)
    throw new ProtocolError('At most ' + MAX_PROCESS_ENV + ' environment variables may be set')
  const parsedEnv: Record<string, string> = {}
  for (const name of names)
    parsedEnv[parseEnvName(name)] = plain(
      env[name],
      MAX_PROCESS_ENV_VALUE_BYTES,
      'Environment value'
    )
  const total =
    parsedArgs.reduce((sum, item) => sum + bytes(item), 0) +
    names.reduce((sum, name) => sum + bytes(name) + bytes(parsedEnv[name]!), 0)
  if (total > MAX_PROCESS_LAUNCH_BYTES)
    throw new ProtocolError('Process arguments and environment exceed 32768 bytes')
  const launch: ProcessLaunch = {
    executable: parseRootId(data['executable']),
    args: parsedArgs,
    env: parsedEnv,
  }
  if ('cwd' in data) {
    const cwd = object(data['cwd'])
    keys(cwd, PROCESS_CWD_KEYS)
    launch.cwd = { grant_id: id(cwd['grant_id']), path: parseFilePath(cwd['path']) }
  }
  if ('terminal' in data) launch.terminal = parseTerminalSize(data['terminal'])
  return launch
}

export function parseProcessSignal(value: unknown): ProcessSignal {
  if (!PROCESS_SIGNALS.includes(value as ProcessSignal))
    throw new ProtocolError('Unknown process signal')
  return value as ProcessSignal
}

export function parseProcessStream(value: unknown): ProcessStream {
  if (value !== 'stdout' && value !== 'stderr' && value !== 'terminal')
    throw new ProtocolError('Unknown process stream')
  return value
}

export function parseProcessOutput(value: unknown): string {
  const data = parseChunk(value)
  if (!data) throw new ProtocolError('Process output chunks are nonempty')
  return data
}

const PROCESS_EXIT_KEYS = fields('code', 'signal')

export function parseProcessExit(value: unknown): ProcessExit {
  const data = object(value)
  keys(data, PROCESS_EXIT_KEYS)
  if ('code' in data && !('signal' in data))
    return { code: integer(data['code'], 'exit code', 0, 255) }
  if ('signal' in data && !('code' in data))
    return { signal: integer(data['signal'], 'exit signal', 1, 64) }
  throw new ProtocolError('A process exit has exactly one exit code or signal')
}
