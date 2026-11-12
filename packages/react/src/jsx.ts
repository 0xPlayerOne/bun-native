import type { Element as NativeElement, InputState } from '@bun-native/core'
import type { EventHandlers, RendererNode } from '@bun-native/renderer'
import type { JSX as ReactJSX, ReactNode, Ref } from 'react'

export namespace JSX {
  export type Element = ReactJSX.Element
  export type ElementType = ReactJSX.ElementType
  export type ElementClass = ReactJSX.ElementClass
  export type ElementAttributesProperty = ReactJSX.ElementAttributesProperty
  export type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute
  export type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>
  export type IntrinsicAttributes = ReactJSX.IntrinsicAttributes
  export type IntrinsicClassAttributes<T> = ReactJSX.IntrinsicClassAttributes<T>

  type Base<K extends NativeElement['kind']> = EventHandlers &
    ReactJSX.IntrinsicAttributes & {
      style?: NonNullable<Extract<NativeElement, { kind: K }>['style']>
      ref?: Ref<RendererNode>
    }
  type TextContent = { text?: string; children?: ReactNode }
  export interface IntrinsicElements {
    /**
     * Requires `accessibility_lists_v1` for the accessible members. A list's
     * `accessibleSetSize` counts every item, mounted or not; an item's
     * `accessiblePosition` is its 1-based place in that full set.
     */
    box: Base<'box'> & { children?: ReactNode } & {
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
      children?: ReactNode
      ratio?: number
      min_size?: number
      /** Requires `accessibility_v1`: the divider's accessible name. */
      accessibleLabel?: string
    }
    /** Painted above the ordinary tree; only window-anchored overlays may be modal. */
    overlay: Base<'overlay'> & {
      children?: ReactNode
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
