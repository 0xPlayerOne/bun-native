import { expect, test } from 'bun:test'
import { NativeStateError, type DropTargetEvent, type NativeDropTarget } from '@bun-native/core'
import { asNode, createElement, createTextNode, registerDropTarget } from '@bun-native/renderer'

type Owner = NonNullable<ReturnType<typeof asNode>['owner']>

test('registerDropTarget delegates a mounted element to its owner and rejects anything else', async () => {
  const calls: unknown[] = []
  const target = { id: 'target' } as unknown as NativeDropTarget
  const owner = {
    registerDropTarget(node: unknown, listener: unknown) {
      calls.push([node, listener])
      return Promise.resolve(target)
    },
  } as unknown as Owner
  const listener = (_event: DropTargetEvent) => {}

  const box = createElement('box')
  asNode(box).owner = owner
  expect(await registerDropTarget(box, listener)).toBe(target)
  expect(calls).toEqual([[asNode(box), listener]])

  for (const unmounted of [createElement('box'), createTextNode('text')]) {
    const error = await registerDropTarget(unmounted, listener).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(NativeStateError)
    expect((error as NativeStateError).code).toBe('invalid_handle')
  }
  expect(calls).toHaveLength(1)
})
