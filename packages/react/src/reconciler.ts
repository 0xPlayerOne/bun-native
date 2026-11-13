import { UnsupportedFeatureError, type Listener, type NativeUIEvent } from '@bun-native/core'
import {
  createElement,
  createTextNode,
  insertNode,
  isEventProperty,
  removeNode,
  replaceText,
  setProperty,
  type ElementTag,
  type Node,
  type PropertyName,
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

function unsupported(feature: string): never {
  throw new UnsupportedFeatureError('react-' + feature)
}

// React requires these hooks even when a host has no corresponding resource.
// Reuse their identical semantics instead of maintaining separate empty bodies.
const noOp = (): void => {}
const noInstance = () => null
const returnFalse = () => false
const hostContext = () => context

/**
 * Run a native callback as a discrete React update. The shared renderer keeps
 * one registration per node/type/phase and calls the latest committed handler,
 * so inline closures replaced on ordinary rerenders keep queued events.
 */
export function dispatchDiscrete(
  listener: Listener<NativeUIEvent>,
  event: NativeUIEvent
): void | Promise<void> {
  const previous = activeEvent
  activeEvent = { type: event.type, observedAt: performance.now() }
  try {
    return reconciler.discreteUpdates(listener, event, undefined, undefined, undefined)
  } finally {
    activeEvent = previous
    reconciler.flushSyncWork()
  }
}

function updateProperty(node: Node, name: string, value: unknown): void {
  if (isEventProperty(name) && value !== undefined && typeof value !== 'function')
    throw new TypeError('Native event listeners must be functions')
  // React props arrive as strings; the renderer rejects unknown names at runtime.
  setProperty(node, name as PropertyName, value)
}

const reserved = (name: string) => name === 'children' || name === 'ref' || name === 'key'

type StyleObject = Readonly<Record<string, unknown>>
const isStyleObject = (value: unknown): value is StyleObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Inline `style={{ ... }}` is a new object on every render. The renderer keeps
 * a shallow copy, so an object with the same own keys, in the same order, and
 * the same values commits the identical element and sends no native set;
 * setting it anyway would only recapture the node and its ancestors.
 */
function sameStyle(previous: unknown, next: unknown): boolean {
  if (!isStyleObject(previous) || !isStyleObject(next)) return false
  const names = Object.keys(previous)
  const nextNames = Object.keys(next)
  if (names.length !== nextNames.length) return false
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!
    if (name !== nextNames[index] || !Object.is(previous[name], next[name])) return false
  }
  return true
}

// React commits every rerendered host fiber, so this runs once per row of a
// rerendered list: compare in place rather than allocating a merged key set.
function updateProperties(node: Node, previous: Props, next: Props): void {
  for (const name of Object.keys(previous))
    if (!reserved(name) && !Object.hasOwn(next, name)) updateProperty(node, name, undefined)
  for (const name of Object.keys(next)) {
    if (reserved(name)) continue
    const value = next[name]
    if (Object.hasOwn(previous, name)) {
      const old = previous[name]
      if (Object.is(old, value) || (name === 'style' && sameStyle(old, value))) continue
    }
    updateProperty(node, name, value)
  }
}

function createProperties(node: Node, props: Props): void {
  for (const name of Object.keys(props))
    if (!reserved(name)) updateProperty(node, name, props[name])
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
    // The host config types an element as any string; the renderer rejects unknown tags.
    const node = createElement(type as ElementTag)
    createProperties(node, props)
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
    node.children.length = 0
    node.parent = undefined
    for (const name of Object.keys(node.properties)) {
      if (isEventProperty(name)) delete node.properties[name]
    }
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
    // Removing the last child pops it; removing the first would leave a hole
    // that the next `children` read compacts, making the loop quadratic.
    const children = container.children
    while (children.length) removeNode(container, children[children.length - 1]!)
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
  // React 19.3 calls this for ordinary transition lanes too. This host has no
  // active view-transition animation whose completion could delay a commit.
  suspendOnActiveViewTransition: noOp,
  createViewTransitionInstance: unsupported.bind(null, 'view-transitions'),
  applyViewTransitionName: unsupported.bind(null, 'view-transitions'),
  startViewTransition: unsupported.bind(null, 'view-transitions'),
  waitForCommitToBeReady: noInstance,
  getSuspendedCommitReason: noInstance,
}

export const reconciler = Reconciler(host)
