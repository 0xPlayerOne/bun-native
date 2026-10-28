/** Portable desktop-window values. Coordinates and sizes use device-independent pixels. */
export interface Bounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Actual adapter readback. A requested action does not promise an OS transition or focus. */
export interface WindowState {
  readonly visible: boolean
  readonly active: boolean
  readonly minimized: boolean
  readonly maximized: boolean
  readonly fullscreen: boolean
}

/** Notifications are observations, not acknowledgments of an earlier requested transition. */
export type WindowEvent =
  | { readonly type: 'state-changed'; readonly state: WindowState }
  | { readonly type: 'bounds-changed'; readonly bounds: Bounds }
  | {
      readonly type: 'fullscreen-transition'
      readonly completed: boolean
      readonly state: WindowState
    }
  | { readonly type: 'closed' }
