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

function unsupported(feature: string): never {
  throw new UnsupportedFeatureError('react-' + feature)
}

function eventListener(value: unknown): Listener<ClickEvent | InputEvent> {
  if (typeof value !== 'function') throw new TypeError('Native event listeners must be functions')
  // Runtime validation establishes callable identity; the native core validates
  // the event and supplies the precise typed event for the registered node.
  const listener = value as Listener<ClickEvent | InputEvent>
  return (event) => {
    const previous = activeEvent
    activeEvent = { type: event.type, observedAt: performance.now() }
    try {
      return reconciler.discreteUpdates(listener, event, undefined, undefined, undefined)
    } finally {
      activeEvent = previous
      reconciler.flushSyncWork()
    }
  }
}

function updateProperties(node: Node, previous: Props, next: Props): void {
  for (const name of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (name === 'children' || name === 'ref' || name === 'key') continue
    const value = next[name]
    if (Object.hasOwn(previous, name) && Object.is(previous[name], value)) continue
    setProperty(
      node,
      name,
      (name === 'onClick' || name === 'onInput') && value !== undefined
        ? eventListener(value)
        : value
    )
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
    return () => log(...args)
  },
  createInstance(type, props) {
    const node = createElement(type)
    updateProperties(node, {}, props)
    return node
  },
  createTextInstance: createTextNode,
  appendInitialChild: insertNode,
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  getRootHostContext: () => context,
  getChildHostContext: () => context,
  getPublicInstance: (node) => node,
  prepareForCommit: () => null,
  resetAfterCommit() {},
  preparePortalMount: () => unsupported('portals'),
  scheduleTimeout: (callback, delay) => setTimeout(callback, delay),
  cancelTimeout: clearTimeout,
  noTimeout: null,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  prepareScopeUpdate: () => unsupported('scope'),
  getInstanceFromScope: () => null,
  detachDeletedInstance(node) {
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
  hideInstance: () => unsupported('hidden-subtrees'),
  hideTextInstance: () => unsupported('hidden-subtrees'),
  unhideInstance: () => unsupported('hidden-subtrees'),
  unhideTextInstance: () => unsupported('hidden-subtrees'),
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
  resetFormInstance: () => unsupported('forms'),
  requestPostPaintCallback: () => unsupported('presentation-timing'),
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent() {},
  resolveEventType: () => activeEvent?.type ?? null,
  resolveEventTimeStamp: () => activeEvent?.observedAt ?? -1,
  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => null,
  suspendInstance: () => unsupported('suspended-host-commit'),
  suspendOnActiveViewTransition: () => unsupported('view-transitions'),
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,
}

export const reconciler = Reconciler(host)
