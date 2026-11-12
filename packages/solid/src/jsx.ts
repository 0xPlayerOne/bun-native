import type { Element as NativeElement, InputState } from '@bun-native/core'
import type { EventHandlers, RendererNode as SolidNode } from '@bun-native/renderer'

export namespace JSX {
  export type Element = SolidNode | string | number | boolean | null | undefined | Element[]
  export interface ElementChildrenAttribute {
    children: unknown
  }
  type Base<Kind extends NativeElement['kind']> = EventHandlers & {
    style?: Extract<NativeElement, { kind: Kind }>['style']
    ref?: (node: SolidNode) => void
  }
  type TextContent = { text?: string; children?: Element }
  export interface IntrinsicElements {
    /**
     * Requires `accessibility_lists_v1` for the accessible members. A list's
     * `accessibleSetSize` counts every item, mounted or not; an item's
     * `accessiblePosition` is its 1-based place in that full set.
     */
    box: Base<'box'> & { children?: Element } & {
      accessibleRole?: 'list' | 'list_item'
      /** Only with `accessibleRole`. */
      accessibleLabel?: string
      /** Only on a `list`. */
      accessibleSetSize?: number
      /** Only on a `list_item`; 1-based. */
      accessiblePosition?: number
      /** Only on a `list_item`. */
      accessibleSelected?: boolean
    }
    text: Base<'text'> &
      TextContent & {
        /** Requires `accessibility_lists_v1`: announce the text when it appears and changes. */
        accessibleLive?: 'polite' | 'assertive'
      }
    button: Base<'button'> & TextContent & { disabled?: boolean }
    input: Base<'input'> & {
      value?: string | InputState
      placeholder?: string
      /** Requires the host's `input_states_v1` capability. */
      disabled?: boolean
      /** Requires the host's `input_states_v1` capability. */
      readOnly?: boolean
    }
    /** At most two pane children; the host owns the divider drag and keyboard steps. */
    split: Base<'split'> & {
      children?: Element
      ratio?: number
      min_size?: number
      /** Requires `accessibility_v1`: the divider's accessible name. */
      accessibleLabel?: string
    }
    /** Painted above the ordinary tree; only window-anchored overlays may be modal. */
    overlay: Base<'overlay'> & {
      children?: Element
      /** Requires `overlay_keyboard_v1`: focus the first enabled control on open. */
      autofocus?: boolean
      /** Requires `overlay_keyboard_v1`: `menu` adds arrow-key roving focus and type-ahead. */
      navigation?: 'tab' | 'menu'
      /** Requires `accessibility_v1`: the dialog's accessible name. */
      accessibleLabel?: string
    } & (
        | { anchor?: 'window'; modal?: boolean; surface?: 'layer' }
        | { anchor: 'parent'; modal?: false; surface?: 'layer' | 'window' }
      )
  }
}
