// Compile-only contract for the JSX namespaces that compilers resolve through
// each framework's jsx-runtime subpath rather than the package root.
import type { JSX as ReactRootJSX } from '@bun-native/react'
import type { JSX as ReactDevJSX } from '@bun-native/react/jsx-dev-runtime'
import type { JSX as ReactJSX } from '@bun-native/react/jsx-runtime'
import type { JSX as SolidRootJSX } from '@bun-native/solid'
import type { JSX as SolidJSX } from '@bun-native/solid/jsx-runtime'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const same = <A, B>(proof: Equal<A, B>): Equal<A, B> => proof

export const reactSubpaths = [
  same<ReactJSX.IntrinsicElements, ReactRootJSX.IntrinsicElements>(true),
  same<ReactDevJSX.IntrinsicElements, ReactRootJSX.IntrinsicElements>(true),
  same<ReactJSX.Element, ReactRootJSX.Element>(true),
] as const
export const solidSubpath = [
  same<SolidJSX.IntrinsicElements, SolidRootJSX.IntrinsicElements>(true),
  same<SolidJSX.Element, SolidRootJSX.Element>(true),
] as const

export const nativeIntrinsics = [
  same<keyof ReactJSX.IntrinsicElements, 'box' | 'text' | 'button' | 'input'>(true),
  same<keyof SolidJSX.IntrinsicElements, 'box' | 'text' | 'button' | 'input'>(true),
  same<keyof SolidJSX.ElementChildrenAttribute, 'children'>(true),
] as const

export const reactButton: ReactJSX.IntrinsicElements['button'] = {
  key: 'save',
  text: 'Save',
  disabled: true,
  style: { gap: 2 },
}
export const solidInput: SolidJSX.IntrinsicElements['input'] = {
  value: { value: 'draft', revision: 1 },
  placeholder: 'Name',
  ref: (node) => void node,
}
export const reactDisabledBox: ReactJSX.IntrinsicElements['box'] = {
  // @ts-expect-error Only buttons accept the native disabled attribute.
  disabled: true,
}
export const solidKeyedText: SolidJSX.IntrinsicElements['text'] = {
  // @ts-expect-error Solid elements carry no React reconciliation key.
  key: 'one',
}
export const solidNumericInput: SolidJSX.IntrinsicElements['input'] = {
  // @ts-expect-error Inputs take text or a revisioned input state, never numbers.
  value: 3,
}
export const reactTextValue: ReactJSX.IntrinsicElements['text'] = {
  // @ts-expect-error Native text exposes text and children, not a value attribute.
  value: 'x',
}
export const solidBoxStyle: SolidJSX.IntrinsicElements['box'] = {
  // @ts-expect-error Styles follow the element kind's native style contract.
  style: { width: '100%' },
}
export const reactDomRef: ReactJSX.IntrinsicElements['box'] = {
  // @ts-expect-error Refs receive renderer nodes, not DOM elements.
  ref: (element: HTMLElement) => void element,
}
