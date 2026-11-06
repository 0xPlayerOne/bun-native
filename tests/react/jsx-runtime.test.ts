import { expect, test } from 'bun:test'
import type { ElementType } from 'react'
import * as nativeRuntime from '@bun-native/react/jsx-runtime'
import * as nativeDevRuntime from '@bun-native/react/jsx-dev-runtime'
import * as reactRuntime from 'react/jsx-runtime'
import * as reactDevRuntime from 'react/jsx-dev-runtime'

// Test files compile JSX through the development runtime, so the production
// automatic runtime is otherwise only reached by application builds.
// React's global JSX types know only DOM intrinsics; native ones come from jsxImportSource.
const intrinsic = (kind: 'box' | 'text') => kind as unknown as ElementType
test('production JSX runtime re-exports exactly React’s automatic runtime values', () => {
  expect(Object.keys(nativeRuntime).sort()).toEqual(['Fragment', 'jsx', 'jsxs'])
  expect(nativeRuntime.Fragment).toBe(reactRuntime.Fragment)
  expect(nativeRuntime.jsx).toBe(reactRuntime.jsx)
  expect(nativeRuntime.jsxs).toBe(reactRuntime.jsxs)
})

test('development JSX runtime re-exports exactly React’s development runtime values', () => {
  expect(Object.keys(nativeDevRuntime).sort()).toEqual(['Fragment', 'jsxDEV'])
  expect(nativeDevRuntime.Fragment).toBe(reactDevRuntime.Fragment)
  expect(nativeDevRuntime.jsxDEV).toBe(reactDevRuntime.jsxDEV)
})

test('production runtime builds native intrinsic elements without a renderer', () => {
  const child = nativeRuntime.jsx(intrinsic('text'), { text: 'label' }, 'first')
  const element = nativeRuntime.jsxs(intrinsic('box'), {
    style: { gap: 4 },
    children: [child, nativeRuntime.jsx(nativeRuntime.Fragment, { children: 'tail' })],
  })
  expect(element.type).toBe('box')
  expect(element.key).toBeNull()
  expect(child.key).toBe('first')
  expect(child.props).toEqual({ text: 'label' })
  const props = element.props as { style: unknown; children: unknown[] }
  expect(props.style).toEqual({ gap: 4 })
  expect(props.children).toHaveLength(2)
})
