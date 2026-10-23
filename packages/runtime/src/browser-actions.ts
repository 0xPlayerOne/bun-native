/**
 * Portable, engine-neutral browser actions (issue #37).
 *
 * The public surface is a capability-based action vocabulary. A concrete
 * embedder (CEF, a future webview adapter) implements the adapter interface
 * below; raw CDP stays an engine-specific extension and is never the only way
 * to drive a view.
 *
 * Every action is bound to an authorized view and session, the target is
 * re-validated after navigation, and remote content never gains
 * application-native authority by being controlled. A capability an embedder
 * does not implement is an explicit, named error - never a silent no-op.
 */

/** The capabilities an embedder can declare. */
export const BROWSER_CAPABILITIES = [
  'navigate',
  'screenshot',
  'snapshot',
  'evaluate',
  'observe-dom',
  'accessibility-tree',
  'input',
] as const
export type BrowserCapability = (typeof BROWSER_CAPABILITIES)[number]

/** The action vocabulary of the portable API. */
export const BROWSER_ACTIONS = [
  'navigate',
  'screenshot',
  'snapshot',
  'evaluate',
  'observe-dom',
  'accessibility-tree',
  'input',
] as const
export type BrowserActionKind = (typeof BROWSER_ACTIONS)[number]

/** The capability each action needs. */
export const ACTION_CAPABILITY: Record<BrowserActionKind, BrowserCapability> = {
  navigate: 'navigate',
  screenshot: 'screenshot',
  snapshot: 'snapshot',
  evaluate: 'evaluate',
  'observe-dom': 'observe-dom',
  'accessibility-tree': 'accessibility-tree',
  input: 'input',
}

/** The named failures a caller can act on. */
export const BROWSER_ERROR_CODES = [
  'unauthorized-target',
  'stale-target',
  'unsupported-capability',
  'navigation-race',
  'cancelled',
  'payload-too-large',
  'cross-origin-frame',
  'evaluation-not-permitted',
  'diagnostics-disabled',
  'adapter-error',
] as const
export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[number]

export type BrowserActionError = { code: BrowserErrorCode; message: string }

/** The authorized view a request is bound to. */
export type BrowserTarget = { viewId: string; sessionId: string; epoch: number }

export type BrowserActionRequest = {
  requestId: string
  target: BrowserTarget
  action: BrowserActionKind
  payload?: unknown
  evaluation?: { expression: string; approved: true }
}

export type BrowserActionResult =
  | { ok: true; requestId: string; epoch: number; value: unknown; truncated?: boolean }
  | { ok: false; requestId: string; error: BrowserActionError }

/** A view the host is willing to let a request drive. */
export type AuthorizedView = {
  viewId: string
  sessionId: string
  epoch: number
  origin: string
  capabilities: readonly BrowserCapability[]
  approvedEvaluations?: readonly string[]
}

/** The engine-specific surface an embedder implements. */
export type BrowserAdapter = {
  capabilities(): readonly BrowserCapability[]
  navigate(view: AuthorizedView, url: string): Promise<{ epoch: number; origin: string }>
  capture(view: AuthorizedView): Promise<{ bytes: number; data: string }>
  snapshot(view: AuthorizedView): Promise<unknown>
  evaluate(view: AuthorizedView, expression: string): Promise<unknown>
  observeDom(view: AuthorizedView): Promise<unknown>
  accessibilityTree(view: AuthorizedView): Promise<unknown>
  input(view: AuthorizedView, payload: unknown): Promise<unknown>
}

export type BrowserActionPolicy = {
  maxScreenshotBytes: number
  debugEnabled: boolean
  productionBuild: boolean
}

export type BrowserActionContext = {
  views: readonly AuthorizedView[]
  authenticated: boolean
  cancelled?: () => boolean
}

const DEFAULT_POLICY: BrowserActionPolicy = {
  maxScreenshotBytes: 4 * 1024 * 1024,
  debugEnabled: false,
  productionBuild: false,
}

function fail(
  request: BrowserActionRequest,
  code: BrowserErrorCode,
  message: string
): BrowserActionResult {
  return { ok: false, requestId: request.requestId, error: { code, message } }
}

/**
 * Dispatches one portable browser action.
 *
 * The order of the checks is the contract: the debug gate, the authorization
 * binding, the capability, the target epoch, the payload bounds, the
 * cancellation, and only then the adapter call.
 */
export async function dispatchBrowserAction(
  request: BrowserActionRequest,
  adapter: BrowserAdapter,
  context: BrowserActionContext,
  policy: BrowserActionPolicy = DEFAULT_POLICY
): Promise<BrowserActionResult> {
  if (context.cancelled?.() === true) return fail(request, 'cancelled', 'the action was cancelled')
  const capability = ACTION_CAPABILITY[request.action]
  if (policy.productionBuild && (request.action === 'evaluate' || request.action === 'snapshot')) {
    return fail(
      request,
      'diagnostics-disabled',
      'the debug surface is disabled in a packaged production build'
    )
  }
  if (
    (request.action === 'evaluate' || request.action === 'snapshot') &&
    (!policy.debugEnabled || !context.authenticated)
  ) {
    return fail(
      request,
      'diagnostics-disabled',
      'the debug surface is opt-in and requires an authenticated caller'
    )
  }
  const view = context.views.find(
    (candidate) =>
      candidate.viewId === request.target.viewId && candidate.sessionId === request.target.sessionId
  )
  if (view === undefined) {
    return fail(
      request,
      'unauthorized-target',
      'the request is not bound to an authorized view and session'
    )
  }
  if (!adapter.capabilities().includes(capability) || !view.capabilities.includes(capability)) {
    return fail(
      request,
      'unsupported-capability',
      `the ${capability} capability is not available for this view`
    )
  }
  if (request.target.epoch !== view.epoch) {
    return fail(request, 'stale-target', 'the request targets a superseded navigation epoch')
  }
  if (request.action === 'evaluate') {
    const expression = request.evaluation?.expression
    if (request.evaluation?.approved !== true || expression === undefined) {
      return fail(
        request,
        'evaluation-not-permitted',
        'only an approved evaluation may be evaluated'
      )
    }
    if (!(view.approvedEvaluations ?? []).includes(expression)) {
      return fail(
        request,
        'evaluation-not-permitted',
        'the evaluation is not approved for this view'
      )
    }
  }
  if (request.action === 'screenshot') {
    const requested = (request.payload as { maxBytes?: number } | undefined)?.maxBytes
    if (requested !== undefined && requested > policy.maxScreenshotBytes) {
      return fail(request, 'payload-too-large', 'the requested screenshot exceeds the bounded size')
    }
  }
  try {
    switch (request.action) {
      case 'navigate': {
        const url = (request.payload as { url?: string } | undefined)?.url ?? ''
        const result = await adapter.navigate(view, url)
        if (result.origin !== view.origin) {
          return fail(request, 'cross-origin-frame', 'the navigation left the authorized origin')
        }
        if (result.epoch <= view.epoch) {
          return fail(request, 'navigation-race', 'the navigation did not advance the epoch')
        }
        return {
          ok: true,
          requestId: request.requestId,
          epoch: result.epoch,
          value: { origin: result.origin },
        }
      }
      case 'screenshot': {
        const capture = await adapter.capture(view)
        if (capture.bytes > policy.maxScreenshotBytes) {
          return fail(request, 'payload-too-large', 'the screenshot exceeds the bounded size')
        }
        return { ok: true, requestId: request.requestId, epoch: view.epoch, value: capture.data }
      }
      case 'snapshot': {
        const value = await adapter.snapshot(view)
        return { ok: true, requestId: request.requestId, epoch: view.epoch, value }
      }
      case 'evaluate': {
        const value = await adapter.evaluate(view, request.evaluation!.expression)
        return { ok: true, requestId: request.requestId, epoch: view.epoch, value }
      }
      case 'observe-dom': {
        const value = await adapter.observeDom(view)
        return { ok: true, requestId: request.requestId, epoch: view.epoch, value }
      }
      case 'accessibility-tree': {
        const value = await adapter.accessibilityTree(view)
        return { ok: true, requestId: request.requestId, epoch: view.epoch, value }
      }
      case 'input': {
        const value = await adapter.input(view, request.payload)
        return { ok: true, requestId: request.requestId, epoch: view.epoch, value }
      }
      default: {
        const exhaustive: never = request.action
        return fail(request, 'adapter-error', `unknown action ${String(exhaustive)}`)
      }
    }
  } catch (error) {
    return fail(request, 'adapter-error', error instanceof Error ? error.message : String(error))
  }
}
