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

  type Base<K extends NativeElement['kind']> = EventHandlers & {
    style?: NonNullable<Extract<NativeElement, { kind: K }>['style']>
    ref?: Ref<RendererNode>
  }
  type TextContent = { text?: string; children?: ReactNode }
  export interface IntrinsicElements {
    box: Base<'box'> & { children?: ReactNode }
    text: Base<'text'> & TextContent
    button: Base<'button'> & TextContent & { disabled?: boolean }
    input: Base<'input'> & {
      value?: string | InputState
      placeholder?: string
    }
  }
}
