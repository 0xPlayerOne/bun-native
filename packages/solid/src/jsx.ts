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
  }
}
