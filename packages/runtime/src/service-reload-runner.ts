/** Disposable trusted application generation; never owns the native desktop connection. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { parentPort } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'
import {
  SERVICE_CHANNEL_DEFAULTS,
  decodeServiceMessage,
  encodeServiceMessage,
  serviceErrorDetail,
  serviceInteger,
  serviceJson,
  serviceLabel,
  serviceRecord,
  type ServiceApplication,
  type ServiceChannelLimits,
  type ServiceDefinition,
  type ServiceHandler,
} from './service-reload-protocol.ts'

const port = parentPort
if (!port && typeof process.send !== 'function')
  throw new Error('Service runner requires its private generation channel')
let limits: ServiceChannelLimits = SERVICE_CHANNEL_DEFAULTS
let phase: 'boot' | 'preparing' | 'ready' | 'active' | 'retired' = 'boot'
let invocation = 0
let lastRequest = 0
const lifetime = new AbortController()
const requestContext = new AsyncLocalStorage<number>()
const handlers = new Map<string, ServiceHandler>()
const calls = new Map<number, AbortController>()
const cleanups = new Set<() => Promise<void>>()
const pending = new Map<
  number,
  { resolve: (value: string) => void; reject: (error: Error) => void }
>()
function send(value: Record<string, unknown>): void {
  const wire = encodeServiceMessage(value, limits.messageBytes)
  if (port) port.postMessage(wire)
  else process.send!(wire)
}
function error(code: string): Error {
  return Object.assign(new Error(code), { code })
}
function register(name: string, handler: ServiceHandler): void {
  if (
    phase !== 'preparing' ||
    !serviceLabel(name) ||
    typeof handler !== 'function' ||
    handlers.has(name) ||
    handlers.size >= limits.handlers
  )
    throw error('INVALID_REGISTRATION')
  handlers.set(name, handler)
}
function own(cleanup: () => void | Promise<void>): () => Promise<void> {
  if (phase === 'retired' || typeof cleanup !== 'function' || cleanups.size >= limits.cleanup)
    throw error('CLEANUP_CAPACITY')
  let completion: Promise<void> | undefined
  const release = () =>
    (completion ??= Promise.resolve()
      .then(cleanup)
      .then(() => {
        cleanups.delete(release)
      }))
  cleanups.add(release)
  return release
}
function invoke(resource: string, operation: string, input: string): Promise<string> {
  if (
    phase !== 'active' ||
    !serviceLabel(resource) ||
    !serviceLabel(operation) ||
    !serviceJson(input, limits.payloadBytes)
  )
    return Promise.reject(error('NOT_ACTIVE_OR_INVALID_ARGUMENT'))
  if (pending.size >= limits.requests || invocation >= Number.MAX_SAFE_INTEGER)
    return Promise.reject(error('CAPACITY'))
  const request = requestContext.getStore()
  if (request !== undefined && (!calls.has(request) || calls.get(request)!.signal.aborted))
    return Promise.reject(error('RETIRED'))
  const id = ++invocation
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      send({ type: 'invoke', id, request: request ?? null, resource, operation, input })
    } catch (failure) {
      pending.delete(id)
      reject(failure)
    }
  })
}
async function initialize(message: Record<string, unknown>): Promise<void> {
  if (phase !== 'boot') throw error('DUPLICATE_INITIALIZATION')
  phase = 'preparing'
  const configuration = message['limits']
  if (!serviceRecord(configuration)) throw error('INVALID_LIMITS')
  for (const key of ['payloadBytes', 'messageBytes', 'requests', 'handlers', 'cleanup'] as const)
    if (!serviceInteger(configuration[key])) throw error('INVALID_LIMITS')
  limits = configuration as unknown as ServiceChannelLimits
  const entry = message['entry']
  const state = message['state']
  if (
    typeof entry !== 'string' ||
    entry.length > 4096 ||
    !isAbsolute(entry) ||
    (state !== undefined && !serviceJson(state, limits.payloadBytes))
  )
    throw error('INVALID_INITIALIZATION')
  const imported: unknown = await import(pathToFileURL(entry).href)
  if (!serviceRecord(imported) || typeof imported['default'] !== 'function')
    throw error('INVALID_APPLICATION_EXPORT')
  const application = imported['default'] as ServiceApplication
  const definition: ServiceDefinition = await application(
    Object.freeze({
      state: state as string | undefined,
      signal: lifetime.signal,
      invoke,
      own,
      handle: register,
    })
  )
  if (lifetime.signal.aborted) return
  if (!serviceRecord(definition) || !serviceLabel(definition.schema))
    throw error('INVALID_DEFINITION')
  if (definition.handlers !== undefined) {
    if (!serviceRecord(definition.handlers)) throw error('INVALID_REGISTRATION')
    const names = Object.keys(definition.handlers)
    if (names.length > limits.handlers) throw error('INVALID_REGISTRATION')
    for (const name of names) register(name, definition.handlers[name]!)
  }
  if (!handlers.size) throw error('NO_HANDLERS')
  if (definition.dispose !== undefined) own(definition.dispose)
  const snapshot = definition.state ?? (state as string | undefined) ?? '{}'
  if (!serviceJson(snapshot, limits.payloadBytes)) throw error('INVALID_STATE')
  phase = 'ready'
  send({
    type: 'ready',
    schema: definition.schema,
    state: snapshot,
    handlers: [...handlers.keys()],
  })
}
async function run(message: Record<string, unknown>): Promise<void> {
  const id = message['id'],
    name = message['handler'],
    input = message['input']
  if (
    phase !== 'active' ||
    !serviceInteger(id) ||
    id <= lastRequest ||
    !serviceLabel(name) ||
    !serviceJson(input, limits.payloadBytes)
  )
    throw error('INVALID_REQUEST')
  lastRequest = id
  const handler = handlers.get(name)
  if (!handler || calls.size >= limits.requests) throw error('REQUEST_CAPACITY')
  const controller = new AbortController()
  calls.set(id, controller)
  try {
    const output = await requestContext.run(id, () => handler(input, { signal: controller.signal }))
    if (!serviceJson(output, limits.payloadBytes)) throw error('INVALID_OUTPUT')
    if (!lifetime.signal.aborted) send({ type: 'result', id, ok: true, output })
  } catch (failure) {
    if (!lifetime.signal.aborted)
      send({ type: 'result', id, ok: false, detail: serviceErrorDetail(failure) })
  } finally {
    calls.delete(id)
  }
}
async function retire(): Promise<void> {
  if (phase === 'retired') return
  phase = 'retired'
  lifetime.abort()
  for (const controller of calls.values()) controller.abort()
  for (const waiting of pending.values()) waiting.reject(error('RETIRED'))
  pending.clear()
  const results = await Promise.allSettled([...cleanups].map((release) => release()))
  const failed = results.find((result) => result.status === 'rejected')
  send({
    type: 'retired',
    ok: !failed,
    ...(failed?.status === 'rejected' ? { detail: serviceErrorDetail(failed.reason) } : {}),
  })
}
function receive(raw: unknown): void {
  try {
    const message = decodeServiceMessage(raw, limits.messageBytes)
    switch (message['type']) {
      case 'initialize':
        void initialize(message).catch(fatal)
        break
      case 'activate':
        if (phase !== 'ready') throw error('INVALID_ACTIVATION')
        phase = 'active'
        break
      case 'call':
        void run(message).catch(fatal)
        break
      case 'cancel': {
        const id = message['id']
        if (!serviceInteger(id)) throw error('INVALID_CANCELLATION')
        calls.get(id)?.abort()
        break
      }
      case 'invocation-result': {
        const id = message['id']
        if (!serviceInteger(id) || typeof message['ok'] !== 'boolean')
          throw error('INVALID_INVOCATION_RESULT')
        const waiting = pending.get(id)
        if (!waiting) break
        pending.delete(id)
        if (message['ok']) {
          if (!serviceJson(message['output'], limits.payloadBytes)) throw error('INVALID_OUTPUT')
          waiting.resolve(message['output'])
        } else
          waiting.reject(error(serviceLabel(message['code']) ? message['code'] : 'ADAPTER_FAILED'))
        break
      }
      case 'retire':
        void retire().catch(fatal)
        break
      default:
        throw error('INVALID_MESSAGE')
    }
  } catch (failure) {
    fatal(failure)
  }
}
function fatal(failure: unknown): void {
  try {
    send({ type: 'failure', detail: serviceErrorDetail(failure) })
  } catch {
    // The owner independently observes generation exit and settles all callers.
  }
  void retire().catch(() => {})
}
if (port) port.on('message', receive)
else {
  process.on('message', receive)
  process.on('disconnect', () => process.exit(0))
}
process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)
send({ type: 'boot' })
