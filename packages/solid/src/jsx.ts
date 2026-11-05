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
    box: Base<'box'> & { children?: Element }
    text: Base<'text'> & TextContent
    button: Base<'button'> & TextContent & { disabled?: boolean }
    input: Base<'input'> & {
      value?: string | InputState
      placeholder?: string
    }
    /** Painted above the ordinary tree; only window-anchored overlays may be modal. */
    overlay: Base<'overlay'> & {
      children?: Element
      /** Requires `overlay_keyboard_v1`: focus the first enabled control on open. */
      autofocus?: boolean
      /** Requires `overlay_keyboard_v1`: `menu` adds arrow-key roving focus and type-ahead. */
      navigation?: 'tab' | 'menu'
    } & ({ anchor?: 'window'; modal?: boolean } | { anchor: 'parent'; modal?: false })
  }
}
