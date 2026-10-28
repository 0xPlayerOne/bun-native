/** Internal native observation; this does not grant focus or renderer authority. */
export interface CefViewFocusState {
  readonly windowVisible: boolean
  readonly windowMinimized: boolean
  readonly viewVisible: boolean
  readonly viewDrawn: boolean
  readonly viewEnabled: boolean
  readonly viewFocusable: boolean
  readonly positiveBounds: boolean
  readonly presentationAllowsFocus: boolean
  readonly overlayAllowsFocus: boolean
  readonly eligible: boolean
}

const keys = [
  'eligible',
  'overlayAllowsFocus',
  'positiveBounds',
  'presentationAllowsFocus',
  'viewDrawn',
  'viewEnabled',
  'viewFocusable',
  'viewVisible',
  'windowMinimized',
  'windowVisible',
] as const

export function parseCefViewFocusState(value: unknown): CefViewFocusState {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.join(',') ||
    keys.some((key) => typeof (value as Record<string, unknown>)[key] !== 'boolean')
  )
    throw new Error('Malformed native CEF view focus state')
  const state = value as CefViewFocusState
  const eligible =
    state.windowVisible &&
    !state.windowMinimized &&
    state.viewVisible &&
    state.viewDrawn &&
    state.viewEnabled &&
    state.viewFocusable &&
    state.positiveBounds &&
    state.presentationAllowsFocus &&
    state.overlayAllowsFocus
  if (state.eligible !== eligible) throw new Error('Inconsistent native CEF view focus state')
  return Object.freeze({ ...state })
}
