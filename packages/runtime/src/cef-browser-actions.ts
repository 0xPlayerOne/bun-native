import { createHash } from 'node:crypto'
import { viewControlBudget, type CefViewControlBudget } from './cef-view-control-budget.ts'
import {
  BROWSER_ACTION_LIMITS as LIMITS,
  BunlyError,
  type BrowserObservation,
  type BrowserScreenshot,
  type InputAction,
} from '../../contracts/src/index.ts'
import type { NativeEvent, NativeTransport } from './native-transport.ts'

export type NativeBrowserAction =
  | { kind: 'screenshot'; width: number; height: number }
  | { kind: 'evaluate'; expression: string }
  | { kind: 'dom' | 'accessibility' }
  | { kind: 'input'; action: InputAction }
export type BrowserActionValue = BrowserScreenshot | BrowserObservation | unknown

type Entry = {
  readonly view: number
  scope: Record<string, unknown>
  readonly action: NativeBrowserAction
  readonly check: () => void
  readonly reservation: number
  readonly lease: Readonly<{ release(): void }>
  readonly promise: Promise<BrowserActionValue>
  resolve: (value: BrowserActionValue) => void
  reject: (error: Error) => void
  admitting: boolean
  id?: number
  early?: NativeEvent
  cancel?: Error
  cancelSent: boolean
  reading: boolean
  seenReady: boolean
  outcome?: { value?: BrowserActionValue; error?: Error }
  settled: boolean
  removeAbort: () => void
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed browser action receipt')
  return value as Record<string, unknown>
}
function integer(value: unknown, maximum: number, minimum = 1): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error('Malformed browser action bound')
  return value
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value)))
    throw new Error('Malformed browser action fields')
}
function failure(value: unknown): Error {
  const codes = [
    'cancelled',
    'stale-target',
    'permission-denied',
    'unsupported-capability',
    'payload-too-large',
    'timeout',
    'adapter-error',
  ]
  if (typeof value !== 'string' || !codes.includes(value))
    throw new Error('Malformed browser action failure')
  if (value === 'cancelled') return new DOMException('Browser action cancelled', 'AbortError')
  return new BunlyError(
    value === 'unsupported-capability' ? 'UNSUPPORTED_CAPABILITY' : 'PERMISSION_DENIED',
    `Browser action failed: ${value}`
  )
}
function boundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= LIMITS.textCharacters * 2 &&
    [...value].length <= LIMITS.textCharacters
  )
}
export function parseBrowserObservation(
  value: unknown,
  kind: 'dom' | 'accessibility'
): BrowserObservation {
  const result = record(value)
  keys(result, ['kind', 'nodes', 'truncated'])
  if (
    result['kind'] !== kind ||
    typeof result['truncated'] !== 'boolean' ||
    !Array.isArray(result['nodes']) ||
    result['nodes'].length > LIMITS.nodes
  )
    throw new Error('Malformed browser observation')
  const depths = new Map<number, number>()
  const nodes = result['nodes'].map((value) => {
    const node = record(value)
    keys(
      node,
      node['parent'] === undefined
        ? ['id', 'depth', 'role', 'name', 'text']
        : ['id', 'parent', 'depth', 'role', 'name', 'text']
    )
    const id = integer(node['id'], LIMITS.nodes)
    const depth = integer(node['depth'], LIMITS.depth, 0)
    if (
      depths.has(id) ||
      !boundedText(node['role']) ||
      !boundedText(node['name']) ||
      !boundedText(node['text'])
    )
      throw new Error('Malformed browser observation node')
    const parent = node['parent'] === undefined ? undefined : integer(node['parent'], LIMITS.nodes)
    if (
      (parent === undefined && (depth !== 0 || depths.size !== 0)) ||
      (parent !== undefined && depths.get(parent) !== depth - 1)
    )
      throw new Error('Malformed browser observation ancestry')
    depths.set(id, depth)
    return Object.freeze({
      id,
      ...(parent === undefined ? {} : { parent }),
      depth,
      role: node['role'],
      name: node['name'],
      text: node['text'],
    })
  })
  if (nodes.length === 0) throw new Error('Empty browser observation is unavailable')
  return Object.freeze({ kind, nodes: Object.freeze(nodes), truncated: result['truncated'] })
}
export function validateBrowserAction(action: NativeBrowserAction): void {
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength
  if (action.kind === 'screenshot') {
    integer(action.width, LIMITS.screenshotWidth)
    integer(action.height, LIMITS.screenshotHeight)
  } else if (action.kind === 'evaluate') {
    if (
      typeof action.expression !== 'string' ||
      !action.expression ||
      action.expression.length > LIMITS.expressionBytes ||
      action.expression.includes('\0') ||
      bytes(action.expression) > LIMITS.expressionBytes
    )
      throw new BunlyError('INVALID_ARGUMENT', 'Browser evaluation source is empty or oversized')
  } else if (action.kind === 'input') {
    const input = action.action
    if (input.type === 'text') {
      if (
        typeof input.text !== 'string' ||
        input.text.length > LIMITS.inputBytes ||
        input.text.includes('\0') ||
        bytes(input.text) > LIMITS.inputBytes
      )
        throw new BunlyError('INVALID_ARGUMENT', 'Synthetic input text is oversized')
    } else if (
      input.type !== 'pointer' ||
      !Number.isFinite(input.x) ||
      !Number.isFinite(input.y) ||
      input.x < 0 ||
      input.y < 0 ||
      input.x > LIMITS.screenshotWidth ||
      input.y > LIMITS.screenshotHeight ||
      !['left', 'right'].includes(input.button)
    )
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid synthetic pointer input')
  }
}

/** A receipt/cancellation ACK is never evidence that CEF callback ownership ended. */
export class CefBrowserActions {
  readonly #transport: NativeTransport
  readonly #budget: CefViewControlBudget
  readonly #entries = new Map<number, Entry>()
  #reservedBytes = 0
  constructor(transport: NativeTransport) {
    this.#transport = transport
    this.#budget = viewControlBudget(transport)
    void transport.closed.then(() =>
      this.close(transport.failure ?? new Error('Native host closed'))
    )
  }
  async run(
    view: number,
    scope: Record<string, unknown> | (() => Promise<Record<string, unknown>>),
    input: NativeBrowserAction,
    check: () => void,
    signal?: AbortSignal
  ): Promise<BrowserActionValue> {
    let action: NativeBrowserAction
    if (input.kind === 'input') {
      const raw = input.action
      if (raw.type === 'text') action = { kind: 'input', action: { type: 'text', text: raw.text } }
      else if (raw.type === 'pointer')
        action = {
          kind: 'input',
          action: { type: 'pointer', x: raw.x, y: raw.y, button: raw.button },
        }
      else throw new BunlyError('INVALID_ARGUMENT', 'Unknown synthetic input action')
    } else if (input.kind === 'screenshot')
      action = { kind: 'screenshot', width: input.width, height: input.height }
    else if (input.kind === 'evaluate') action = { kind: 'evaluate', expression: input.expression }
    else if (input.kind === 'dom' || input.kind === 'accessibility') action = { kind: input.kind }
    else throw new BunlyError('UNSUPPORTED_CAPABILITY', 'Unknown browser action')
    validateBrowserAction(action)
    check()
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    const reservation = 3 * LIMITS.screenshotBytes
    if (
      this.#entries.has(view) ||
      this.#entries.size >= LIMITS.operations ||
      this.#reservedBytes + reservation > LIMITS.ownedBytes
    )
      throw new BunlyError('RESOURCE_IN_USE', 'Browser action capacity exceeded')
    const lease = this.#budget.reserve(view, reservation)
    const deferred = Promise.withResolvers<BrowserActionValue>()
    // Admission may reject before the caller starts awaiting the result.
    void deferred.promise.catch(() => {})
    const entry: Entry = {
      view,
      scope: typeof scope === 'function' ? {} : scope,
      action,
      check,
      reservation,
      lease,
      ...deferred,
      admitting: false,
      cancelSent: false,
      reading: false,
      seenReady: false,
      settled: false,
      removeAbort() {},
    }
    this.#entries.set(view, entry)
    this.#reservedBytes += reservation
    const abort = () => {
      entry.cancel ??=
        signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
      this.#cancel(entry)
    }
    signal?.addEventListener('abort', abort, { once: true })
    entry.removeAbort = () => signal?.removeEventListener('abort', abort)
    // Reserve before capturing native scope; this bounds deferred scope calls too.
    try {
      if (typeof scope === 'function') entry.scope = await scope()
      check()
      if (entry.cancel) throw entry.cancel
      if (entry.settled) return deferred.promise
    } catch (error) {
      this.#settle(
        entry,
        undefined,
        error instanceof Error ? error : new Error('Browser scope capture failed')
      )
      return deferred.promise
    }
    entry.admitting = true
    let acknowledgement: unknown
    try {
      acknowledgement = await this.#transport.call('browser.action.start', {
        id: view,
        scope: entry.scope,
        action,
      })
    } catch (error) {
      // An explicit rejection has no native owner. A receipt contradicting that
      // rejection, or transport loss, must end the transport before quota frees.
      if (entry.early)
        this.#transport.fail(new Error('Browser admission rejection contradicted its receipt'))
      else if (!this.#transport.failure)
        this.#settle(
          entry,
          undefined,
          error instanceof Error ? error : new Error('Browser action admission failed')
        )
      return deferred.promise
    }
    try {
      const response = record(acknowledgement)
      keys(response, ['id'])
      entry.id = integer(response['id'], Number.MAX_SAFE_INTEGER)
      if (entry.early) {
        const early = entry.early
        delete entry.early
        this.#event(entry, early)
      }
      if (entry.cancel) this.#cancel(entry)
    } catch (error) {
      // A successful-but-malformed ACK can still own native callbacks. Close
      // the transport; its close receipt, not this catch, releases admission.
      this.#transport.fail(error)
    }
    return deferred.promise
  }
  event(event: NativeEvent): void {
    if (!event.event.startsWith('browser.action.')) return
    const entry = event.target === undefined ? undefined : this.#entries.get(event.target)
    if (!entry || entry.settled || !entry.admitting)
      throw new Error('Unowned native browser action event')
    if (entry.id === undefined) {
      if (entry.early) throw new Error('Duplicate early browser action receipt')
      entry.early = event
    } else this.#event(entry, event)
  }
  #event(entry: Entry, event: NativeEvent): void {
    const data = record(event.data)
    if (data['id'] !== entry.id) throw new Error('Mismatched browser action receipt')
    if (event.event === 'browser.action.finished') {
      keys(data, ['id', 'failure'])
      this.#settle(entry, undefined, entry.cancel ?? failure(data['failure']))
    } else if (event.event === 'browser.action.ready') {
      if (entry.seenReady) throw new Error('Duplicate browser action readiness')
      entry.seenReady = true
      keys(data, ['id', 'bytes', 'sha256', 'width', 'height'])
      entry.reading = true
      void this.#read(entry, data)
        .catch((error: unknown) => {
          if (entry.outcome) return
          entry.cancel ??= error instanceof Error ? error : new Error('Browser action read failed')
          this.#cancel(entry)
        })
        .finally(() => {
          entry.reading = false
          if (entry.outcome) this.#settle(entry, entry.outcome.value, entry.outcome.error)
        })
    } else throw new Error('Unknown native browser action event')
  }
  #cancel(entry: Entry): void {
    if (entry.id === undefined || entry.cancelSent || entry.settled) return
    entry.cancelSent = true
    void this.#transport
      .call('browser.action.cancel', { id: entry.view, operation: entry.id })
      .then((value) => {
        if (value !== null) throw new Error('Malformed browser cancellation acknowledgement')
      })
      .catch((error: unknown) => this.#transport.fail(error))
  }
  async #read(entry: Entry, metadata: Record<string, unknown>): Promise<void> {
    if (entry.cancel) {
      this.#cancel(entry)
      return
    }
    entry.check()
    const maximum = entry.action.kind === 'screenshot' ? LIMITS.screenshotBytes : LIMITS.resultBytes
    const size = integer(metadata['bytes'], maximum)
    const hash = metadata['sha256']
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error('Malformed browser result digest')
    const output = new Uint8Array(size)
    const digest = createHash('sha256')
    let offset = 0
    while (offset < size) {
      entry.check()
      if (entry.cancel || entry.settled || entry.outcome) {
        this.#cancel(entry)
        return
      }
      const response = record(
        await this.#transport.call('browser.action.read', {
          id: entry.view,
          operation: entry.id,
          scope: entry.scope,
          offset,
        })
      )
      if (entry.outcome) return
      keys(response, ['id', 'offset', 'hex'])
      const hex = response['hex']
      if (
        response['id'] !== entry.id ||
        response['offset'] !== offset ||
        typeof hex !== 'string' ||
        hex.length === 0 ||
        hex.length > 8192 ||
        hex.length % 2 !== 0 ||
        !/^[a-f0-9]+$/.test(hex) ||
        hex.length / 2 > size - offset
      )
        throw new Error('Malformed browser result chunk')
      const chunk = Buffer.from(hex, 'hex')
      output.set(chunk, offset)
      digest.update(chunk)
      offset += chunk.byteLength
    }
    entry.check()
    if (entry.cancel || entry.settled || entry.outcome) {
      this.#cancel(entry)
      return
    }
    if (digest.digest('hex') !== hash) throw new Error('Browser result digest mismatch')
    let result: BrowserActionValue
    if (entry.action.kind === 'screenshot') {
      const width = integer(metadata['width'], entry.action.width)
      const height = integer(metadata['height'], entry.action.height)
      const header = new DataView(output.buffer, output.byteOffset, output.byteLength)
      if (
        size < 57 ||
        header.getUint32(8) !== 13 ||
        Buffer.from(output.subarray(size - 12)).toString('hex') !== '0000000049454e44ae426082' ||
        Buffer.from(output.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a' ||
        header.getUint32(12) !== 0x49484452 ||
        header.getUint32(16) !== width ||
        header.getUint32(20) !== height
      )
        throw new Error('Malformed browser screenshot')
      result = Object.freeze({ format: 'png', width, height, data: output })
    } else {
      if (metadata['width'] !== 0 || metadata['height'] !== 0)
        throw new Error('Unexpected browser result dimensions')
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output)) as unknown
      if (entry.action.kind === 'dom' || entry.action.kind === 'accessibility')
        result = parseBrowserObservation(value, entry.action.kind)
      else {
        const receipt = record(value)
        if (entry.action.kind === 'input') {
          keys(receipt, ['accepted', 'synthetic'])
          if (receipt['accepted'] !== true || receipt['synthetic'] !== true)
            throw new Error('Unsupported synthetic input')
          result = undefined
        } else {
          keys(receipt, receipt['defined'] === false ? ['defined'] : ['defined', 'value'])
          if (typeof receipt['defined'] !== 'boolean')
            throw new Error('Malformed browser evaluation')
          result = receipt['value']
        }
      }
    }
    try {
      const released = await this.#transport.call('browser.action.release', {
        id: entry.view,
        operation: entry.id,
      })
      if (released !== null) throw new Error('Malformed browser release acknowledgement')
    } catch (error) {
      // A release failure cannot safely be converted to cancellation: a peer
      // may already have removed the native owner and its deadline.
      this.#transport.fail(error)
      return
    }
    try {
      entry.check()
    } catch (error) {
      entry.cancel ??= error instanceof Error ? error : new Error('Browser target changed')
    }
    this.#settle(entry, result, entry.cancel)
  }
  #settle(entry: Entry, value?: BrowserActionValue, error?: Error): void {
    if (entry.settled) return
    entry.outcome ??= {
      ...(value === undefined ? {} : { value }),
      ...(error === undefined ? {} : { error }),
    }
    if (entry.reading) return
    value = entry.outcome.value
    error = entry.outcome.error
    entry.settled = true
    entry.removeAbort()
    this.#entries.delete(entry.view)
    this.#reservedBytes -= entry.reservation
    entry.lease.release()
    if (error) entry.reject(error)
    else entry.resolve(value)
  }
  close(error: Error): void {
    for (const entry of this.#entries.values()) this.#settle(entry, undefined, error)
  }
  get diagnostics(): Readonly<{ operations: number; reservedBytes: number }> {
    return Object.freeze({ operations: this.#entries.size, reservedBytes: this.#reservedBytes })
  }
}
