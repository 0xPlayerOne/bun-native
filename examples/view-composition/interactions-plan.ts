import type { Pane } from './contract.ts'

export const COMPOSITION_INTERACTION_WORKLOAD_MS = 30_000
export const interactionSteps = [
  { name: 'left-ready', focused: 'left', overlayVisible: false },
  { name: 'left-menu-closed', focused: 'left', overlayVisible: false },
  { name: 'right-ready', focused: 'right', overlayVisible: false },
  { name: 'right-menu-closed', focused: 'right', overlayVisible: false },
  { name: 'overlay-shown', focused: 'overlay', overlayVisible: true },
  { name: 'overlay-menu-closed', focused: 'overlay', overlayVisible: true },
  { name: 'overlay-dialog-closed', focused: 'overlay', overlayVisible: true },
  { name: 'overlay-hidden', focused: 'left', overlayVisible: false },
  { name: 'overlay-reopened', focused: 'overlay', overlayVisible: true },
  { name: 'overlay-final-hidden', focused: 'right', overlayVisible: false },
] as const

export interface InteractionPaneState {
  readonly nativeFocused: boolean
  readonly pageFocused: boolean
  readonly visible: boolean
  readonly drawn: boolean
  readonly focusable: boolean
  readonly pageVisibility: 'visible' | 'hidden'
  readonly sequence: number
}
export interface InteractionFocusObservation {
  readonly name: (typeof interactionSteps)[number]['name']
  readonly panes: Readonly<Record<Pane, InteractionPaneState>>
}

export const interactionMenuEvents = [
  { type: 'menu-shown', sequence: 1 },
  { type: 'menu-closed', sequence: 2 },
] as const
