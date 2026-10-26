/** CEF Views readback, not a portable BrowserBackend capability or page visibility. */
export interface CefWindowState {
  readonly visible: boolean
  readonly active: boolean
  readonly minimized: boolean
  readonly maximized: boolean
  readonly fullscreen: boolean
}

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
