/** Shared receipt grammar. Requested mode is not observed native or page state. */
export type LoadMode = 'visible' | 'hidden' | 'foreground' | 'background' | 'minimized'
export interface NativeLoadState {
  readonly visible: boolean
  readonly active: boolean
  readonly minimized: boolean
  readonly maximized: boolean
  readonly fullscreen: boolean
}
export const expectedVisibility = (selected: LoadMode): 'visible' | 'hidden' =>
  selected === 'hidden' || selected === 'minimized' ? 'hidden' : 'visible'
export function parseLoadState(value: unknown): NativeLoadState {
  const keys = ['active', 'fullscreen', 'maximized', 'minimized', 'visible']
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.join(',') ||
    keys.some((key) => typeof (value as Record<string, unknown>)[key] !== 'boolean')
  )
    throw new Error('Invalid native load window state')
  const state = value as NativeLoadState
  return Object.freeze({
    visible: state.visible,
    active: state.active,
    minimized: state.minimized,
    maximized: state.maximized,
    fullscreen: state.fullscreen,
  })
}
export function matchesLoadMode(selected: LoadMode, value: unknown): boolean {
  const state = parseLoadState(value)
  if (state.maximized || state.fullscreen) return false
  if (selected === 'minimized') return state.minimized && !state.active
  if (state.minimized) return false
  if (selected === 'hidden') return !state.visible && !state.active
  if (!state.visible) return false
  if (selected === 'foreground') return state.active
  if (selected === 'background') return !state.active
  return selected === 'visible'
}
export function requireLoadMode(selected: LoadMode, state: unknown, visibility: unknown) {
  if (!matchesLoadMode(selected, state) || visibility !== expectedVisibility(selected))
    throw new Error('Native window mode and renderer visibility did not agree')
  return Object.freeze({ mode: selected, nativeState: parseLoadState(state), visibility })
}
