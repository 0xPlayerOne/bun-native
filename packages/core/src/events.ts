import type { WindowEvent } from '@bun-native/runtime'
import {
  NativeStateError,
  type Listener,
  type ListenerOptions,
  type NativeEventMap,
  type NativeEventType,
  type NativeNode,
  type NativeUIEvent,
} from './types.ts'

export type RoutedEvent = Exclude<WindowEvent, { type: 'closed' }>
const eventTypes: readonly string[] = [
  'click',
  'input',
  'key_down',
  'key_up',
  'pointer_down',
  'pointer_up',
  'focus',
  'blur',
]
type BindingKey = `${NativeEventType}:${'capture' | 'bubble'}`
type Binding = {
  node: NativeNode
  controller: AbortController
  invoke: Listener<NativeUIEvent>
}
type Delivery = { binding: Binding; phase: NativeUIEvent['phase'] }

function payload(event: RoutedEvent, node: NativeNode, path: readonly NativeNode[]) {
  const common = {
    node,
    path: Object.freeze([...path]),
    sequence: event.sequence,
    treeRevision: event.tree_revision,
  }
  switch (event.type) {
    case 'click':
      return { ...common, type: event.type, node: node as NativeNode<'button'> }
    case 'input':
      return {
        ...common,
        type: event.type,
        node: node as NativeNode<'input'>,
        value: event.value,
        revision: event.input_revision,
      }
    case 'key_down':
    case 'key_up':
      return {
        ...common,
        type: event.type,
        key: event.key,
        ...(event.key_char === undefined ? {} : { keyChar: event.key_char }),
        modifiers: Object.freeze({ ...event.modifiers }),
      }
    case 'pointer_down':
    case 'pointer_up':
      return {
        ...common,
        type: event.type,
        button: event.button,
        x: event.x,
        y: event.y,
        modifiers: Object.freeze({ ...event.modifiers }),
      }
    case 'focus':
    case 'blur':
      return { ...common, type: event.type }
  }
}

export interface DispatchPlan {
  readonly targetId: number
  readonly cancellation: AbortController
  readonly data: ReturnType<typeof payload>
  deliveries: Delivery[]
}

/** A queued event never gains authority from a later replacement registration. */
export function prunePlan(plan: DispatchPlan): boolean {
  plan.deliveries = plan.deliveries.filter(({ binding }) => !binding.controller.signal.aborted)
  return !plan.cancellation.signal.aborted && plan.deliveries.length !== 0
}

/** One live binding per owned node, event type and phase. No global roots. */
export class EventBindings {
  private readonly nodes = new Map<number, Map<BindingKey, Binding>>()
  private readonly plans = new Set<DispatchPlan>()

  constructor(private readonly changed: () => void) {}

  get size(): number {
    let size = 0
    for (const bindings of this.nodes.values()) size += bindings.size
    return size
  }

  register<T extends NativeEventType>(
    id: number,
    node: NativeNode,
    type: T,
    listener: Listener<NativeEventMap[T]>,
    options: ListenerOptions = {}
  ): () => void {
    if (
      !eventTypes.includes(type) ||
      typeof listener !== 'function' ||
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'capture') ||
      ('capture' in options && typeof options.capture !== 'boolean')
    )
      throw new NativeStateError(
        'invalid_state',
        'Invalid native listener type, function or options'
      )
    const key: BindingKey = `${type}:${options.capture ? 'capture' : 'bubble'}`
    const bindings = this.nodes.get(id) ?? new Map<BindingKey, Binding>()
    this.nodes.set(id, bindings)
    const previous = bindings.get(key)
    const binding: Binding = {
      node,
      controller: new AbortController(),
      // Capture only events of this registered type when preparing a plan.
      invoke: (event) => listener(event as NativeEventMap[T]),
    }
    bindings.set(key, binding)
    // Publish first: an abort handler may install a newer binding reentrantly.
    previous?.controller.abort()
    this.changed()
    return () => {
      if (this.nodes.get(id)?.get(key) !== binding) return
      bindings.delete(key)
      if (!bindings.size) this.nodes.delete(id)
      binding.controller.abort()
      this.changed()
    }
  }

  retain(ids: ReadonlyMap<number, unknown>): void {
    for (const [id, bindings] of this.nodes) {
      if (ids.has(id)) continue
      this.nodes.delete(id)
      for (const binding of bindings.values()) binding.controller.abort()
    }
    for (const plan of this.plans) if (!ids.has(plan.targetId)) plan.cancellation.abort()
    this.changed()
  }

  clear(): void {
    const removed = [...this.nodes.values()]
    this.nodes.clear()
    for (const bindings of removed)
      for (const binding of bindings.values()) binding.controller.abort()
    for (const plan of this.plans) plan.cancellation.abort()
    this.plans.clear()
    this.changed()
  }

  release(plan: DispatchPlan): void {
    this.plans.delete(plan)
    plan.deliveries.length = 0
  }

  prepare(event: RoutedEvent, path: readonly NativeNode[]): DispatchPlan | undefined {
    const deliveries: Delivery[] = []
    const append = (index: number, capture: boolean) => {
      const binding = this.nodes
        .get(event.path[index]!)
        ?.get(`${event.type}:${capture ? 'capture' : 'bubble'}`)
      if (binding)
        deliveries.push({
          binding,
          phase: index === path.length - 1 ? 'target' : capture ? 'capture' : 'bubble',
        })
    }
    for (let index = 0; index < path.length; index++) append(index, true)
    for (let index = path.length - 1; index >= 0; index--) append(index, false)
    if (!deliveries.length) return
    const plan = {
      targetId: event.node_id,
      cancellation: new AbortController(),
      data: payload(event, path.at(-1)!, path),
      deliveries,
    }
    this.plans.add(plan)
    return plan
  }
}

/** Binding cancellation releases an uncooperative callback without blocking ingestion. */
export async function dispatchPlan(plan: DispatchPlan, targetIsLive: () => boolean): Promise<void> {
  let stopped = false
  let immediate = false
  let previous: NativeNode | undefined
  let previousPhase: NativeUIEvent['phase'] | undefined
  try {
    for (const { binding, phase } of plan.deliveries) {
      if (
        !targetIsLive() ||
        plan.cancellation.signal.aborted ||
        immediate ||
        (stopped && (binding.node !== previous || phase !== 'target' || previousPhase !== 'target'))
      )
        break
      if (binding.controller.signal.aborted) continue
      previous = binding.node
      previousPhase = phase
      const signal = binding.controller.signal
      let executing = true
      const stop = (all: boolean) => {
        if (!executing || signal.aborted) return
        stopped = true
        immediate ||= all
      }
      const event: NativeUIEvent = Object.freeze({
        ...plan.data,
        currentTarget: binding.node,
        phase,
        signal,
        get propagationStopped() {
          return stopped
        },
        stopPropagation: () => stop(false),
        stopImmediatePropagation: () => stop(true),
      })
      let cancel!: () => void
      const cancelled = new Promise<void>((resolve) => {
        cancel = resolve
      })
      signal.addEventListener('abort', cancel, { once: true })
      plan.cancellation.signal.addEventListener('abort', cancel, { once: true })
      try {
        await Promise.race([binding.invoke(event), cancelled])
      } finally {
        executing = false
        signal.removeEventListener('abort', cancel)
        plan.cancellation.signal.removeEventListener('abort', cancel)
      }
    }
  } finally {
    plan.deliveries.length = 0
  }
}
