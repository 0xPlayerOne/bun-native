import { ProtocolError } from './framing.ts'
import { parseChunk, parseFilePath, parseRootId, parseRootPath } from './files.ts'
import { id, integer, keys, object } from './values.ts'

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
const encoder = new TextEncoder()
const bytes = (value: string) => encoder.encode(value).byteLength

export interface ProcessExecutable {
  id: string
  executable: string
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

function executable(value: unknown): ProcessExecutable {
  const data = object(value)
  keys(data, ['id', 'executable'])
  const path = parseRootPath(data['executable'])
  // `/` and `X:\` are the only normalized paths ending in a separator.
  if (path.endsWith('/') || path.endsWith('\\'))
    throw new ProtocolError('Process executable must name a file')
  return { id: parseRootId(data['id']), executable: path }
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

/** The reserved native launch argument for one validated executable. */
export function processArgument(value: ProcessExecutable): string {
  const entry = executable(value)
  return PROCESS_ARGUMENT + entry.id + ':' + entry.executable
}

export function processesFromArguments(argv: readonly string[]): ProcessExecutable[] {
  return parseProcessExecutables(
    argv
      .filter((argument) => argument.startsWith(PROCESS_ARGUMENT))
      .map((argument) => {
        const [entry, ...path] = argument.slice(PROCESS_ARGUMENT.length).split(':')
        return { id: entry, executable: path.join(':') }
      })
  )
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

export function parseTerminalSize(value: unknown): TerminalSize {
  const data = object(value)
  keys(data, ['columns', 'rows'])
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

export function parseProcessLaunch(value: unknown): ProcessLaunch {
  const data = object(value)
  keys(data, ['executable', 'args', 'env', 'cwd', 'terminal'])
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
    keys(cwd, ['grant_id', 'path'])
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

export function parseProcessExit(value: unknown): ProcessExit {
  const data = object(value)
  keys(data, ['code', 'signal'])
  if ('code' in data && !('signal' in data))
    return { code: integer(data['code'], 'exit code', 0, 255) }
  if ('signal' in data && !('code' in data))
    return { signal: integer(data['signal'], 'exit signal', 1, 64) }
  throw new ProtocolError('A process exit has exactly one exit code or signal')
}
