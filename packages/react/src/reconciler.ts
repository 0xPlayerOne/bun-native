import {
  UnsupportedFeatureError,
  type ClickEvent,
  type InputEvent,
  type Listener,
} from '@bun-native/core'
import {
  createElement,
  createTextNode,
  insertNode,
  removeNode,
  replaceText,
  setProperty,
  type Node,
  type RendererNode,
} from '@bun-native/renderer'
import { createContext } from 'react'
import Reconciler from 'react-reconciler'
import { DefaultEventPriority, NoEventPriority } from 'react-reconciler/constants'

type Props = Readonly<Record<string, unknown>>
type HostContext = Readonly<Record<string, never>>
type Timer = ReturnType<typeof setTimeout>

// Unsupported host surfaces use never; no React Fiber fields are inspected.
type Config = Reconciler.HostConfig<
  string,
  Props,
  Node,
  Node,
  Node,
  never,
  never,
  never,
  never,
  RendererNode,
  HostContext,
  never,
  Timer,
  null,
  null,
  null,
  never,
  never,
  never,
  never
>

const context: HostContext = Object.freeze({})
let updatePriority: Reconciler.EventPriority = NoEventPriority
let activeEvent: { type: string; observedAt: number } | undefined
type NativeEvent = ClickEvent | InputEvent
type EventBinding = { listener: Listener<NativeEvent> | undefined; dispatch: Listener<NativeEvent> }
const bindings = new WeakMap<Node, Map<string, EventBinding>>()

function unsupported(feature: string): never {
  throw new UnsupportedFeatureError('react-' + feature)
}

// React requires these hooks even when a host has no corresponding resource.
// Reuse their identical semantics instead of maintaining separate empty bodies.
const noOp = (): void => {}
const noInstance = () => null
const returnFalse = () => false
const hostContext = () => context

function createBinding(listener: Listener<NativeEvent>): EventBinding {
  const binding: EventBinding = { listener, dispatch }
  function dispatch(event: NativeEvent): void | Promise<void> {
    const current = binding.listener
    if (!current) return
    const previous = activeEvent
    activeEvent = { type: event.type, observedAt: performance.now() }
    try {
      return reconciler.discreteUpdates(current, event, undefined, undefined, undefined)
    } finally {
      activeEvent = previous
      reconciler.flushSyncWork()
    }
  }
  return binding
}

function updateEvent(node: Node, name: string, value: unknown): void {
  const registered = bindings.get(node)
  const existing = registered?.get(name)
  if (value === undefined) {
    if (existing) existing.listener = undefined
    registered?.delete(name)
    setProperty(node, name, undefined)
    return
  }
  if (typeof value !== 'function') throw new TypeError('Native event listeners must be functions')
  // The callable boundary is checked here; core supplies the validated event.
  const listener = value as Listener<NativeEvent>
  if (existing) {
    // React replaces inline closures on ordinary rerenders. Keep the node's
    // native registration alive so queued input/clicks retain their ordering.
    existing.listener = listener
    return
  }
  const binding = createBinding(listener)
  setProperty(node, name, binding.dispatch)
  const next = registered ?? new Map<string, EventBinding>()
  next.set(name, binding)
  bindings.set(node, next)
}

function updateProperties(node: Node, previous: Props, next: Props): void {
  for (const name of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (name === 'children' || name === 'ref' || name === 'key') continue
    const value = next[name]
    if (Object.hasOwn(previous, name) && Object.is(previous[name], value)) continue
    if (name === 'onClick' || name === 'onInput') updateEvent(node, name, value)
    else setProperty(node, name, value)
  }
}

const host: Config = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsResources: false,
  supportsSingletons: false,
  supportsTestSelectors: false,
  isPrimaryRenderer: true,
  rendererVersion: '0.0.0',
  rendererPackageName: '@bun-native/react',
  extraDevToolsConfig: null,
  bindToConsole(method, args) {
    const log = method === 'warn' ? console.warn : method === 'error' ? console.error : console.log
    return log.bind(console, ...args)
  },
  createInstance(type, props) {
    const node = createElement(type)
    updateProperties(node, {}, props)
    return node
  },
  createTextInstance: createTextNode,
  appendInitialChild: insertNode,
  finalizeInitialChildren: returnFalse,
  shouldSetTextContent: returnFalse,
  getRootHostContext: hostContext,
  getChildHostContext: hostContext,
  getPublicInstance: (node) => node,
  prepareForCommit: noInstance,
  resetAfterCommit: noOp,
  preparePortalMount: unsupported.bind(null, 'portals'),
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: null,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  getInstanceFromNode: noInstance,
  beforeActiveInstanceBlur: noOp,
  afterActiveInstanceBlur: noOp,
  prepareScopeUpdate: unsupported.bind(null, 'scope'),
  getInstanceFromScope: noInstance,
  detachDeletedInstance(node) {
    for (const binding of bindings.get(node)?.values() ?? []) binding.listener = undefined
    bindings.delete(node)
    node.children.length = 0
    node.parent = undefined
    delete node.properties.onClick
    delete node.properties.onInput
  },
  appendChild: insertNode,
  appendChildToContainer: insertNode,
  insertBefore: insertNode,
  insertInContainerBefore: insertNode,
  removeChild: removeNode,
  removeChildFromContainer: removeNode,
  commitTextUpdate: (node, _previous, next) => replaceText(node, next),
  commitUpdate: (node, _type, previous, next) => updateProperties(node, previous, next),
  hideInstance: unsupported.bind(null, 'hidden-subtrees'),
  hideTextInstance: unsupported.bind(null, 'hidden-subtrees'),
  unhideInstance: unsupported.bind(null, 'hidden-subtrees'),
  unhideTextInstance: unsupported.bind(null, 'hidden-subtrees'),
  clearContainer(container) {
    while (container.children.length) removeNode(container, container.children[0]!)
  },
  NotPendingTransition: null,
  HostTransitionContext: createContext(null),
  setCurrentUpdatePriority(priority) {
    updatePriority = priority
  },
  getCurrentUpdatePriority: () => updatePriority,
  resolveUpdatePriority: () => updatePriority || DefaultEventPriority,
  resetFormInstance: unsupported.bind(null, 'forms'),
  requestPostPaintCallback: unsupported.bind(null, 'presentation-timing'),
  shouldAttemptEagerTransition: returnFalse,
  trackSchedulerEvent: noOp,
  resolveEventType: () => activeEvent?.type ?? null,
  resolveEventTimeStamp: () => activeEvent?.observedAt ?? -1,
  maySuspendCommit: returnFalse,
  maySuspendCommitOnUpdate: returnFalse,
  maySuspendCommitInSyncRender: returnFalse,
  preloadInstance: () => true,
  startSuspendingCommit: noInstance,
  suspendInstance: unsupported.bind(null, 'suspended-host-commit'),
  suspendOnActiveViewTransition: unsupported.bind(null, 'view-transitions'),
  waitForCommitToBeReady: noInstance,
  getSuspendedCommitReason: noInstance,
}

export const reconciler = Reconciler(host)
