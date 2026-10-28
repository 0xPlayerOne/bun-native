import type { Bounds, WindowState } from '../../contracts/src/windows.ts'
/** Compatibility name for the unchanged five-boolean native readback. */
export type CefWindowState = WindowState

export function parseCefWindowState(value: unknown): CefWindowState {
  const keys = ['active', 'fullscreen', 'maximized', 'minimized', 'visible']
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.join(',') ||
    keys.some((key) => typeof (value as Record<string, unknown>)[key] !== 'boolean')
  )
    throw new Error('Malformed native CEF window state')
  const state = value as CefWindowState
  return Object.freeze({
    visible: state.visible,
    active: state.active,
    minimized: state.minimized,
    maximized: state.maximized,
    fullscreen: state.fullscreen,
  })
}

/** Native geometry may be empty while transitioning; do not replace it with requested intent. */
export function parseCefWindowBounds(value: unknown): Bounds {
  const keys = ['height', 'width', 'x', 'y']
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.join(',') ||
    keys.some((key) => !Number.isSafeInteger((value as Record<string, unknown>)[key]))
  )
    throw new Error('Malformed native CEF window bounds')
  const bounds = value as Bounds
  if (
    bounds.x < -2147483648 ||
    bounds.x > 2147483647 ||
    bounds.y < -2147483648 ||
    bounds.y > 2147483647 ||
    bounds.width < 0 ||
    bounds.width > 2147483647 ||
    bounds.height < 0 ||
    bounds.height > 2147483647
  )
    throw new Error('Malformed native CEF window bounds')
  return Object.freeze({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
}
