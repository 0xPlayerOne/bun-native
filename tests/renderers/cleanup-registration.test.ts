import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { NativeStateError } from '@bun-native/core'
import { createRenderRoot, type RenderContext } from '@bun-native/renderer'
import { withApp } from './support.ts'

const terminalModes = [
  'dispose',
  'window-close',
  'framework-failure',
  'initialization-failure',
] as const

for (const mode of terminalModes) {
  test(`framework cleanup registration stays revoked after ${mode}`, () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Terminal cleanup registration' })
      const failure = new Error('Original framework failure')
      let context!: RenderContext
      let cleanups = 0
      let lateCleanups = 0
      const root = createRenderRoot(window, (value) => {
        context = value
        value.onCleanup(() => cleanups++)
        if (mode === 'initialization-failure') throw failure
      })
      if (mode === 'initialization-failure') {
        await assert.rejects(root.ready, (error) => error === failure)
      } else {
        await root.ready
        if (mode === 'dispose') await root.dispose()
        else if (mode === 'window-close') await window.close()
        else context.fail(failure)
      }
      if (mode === 'framework-failure' || mode === 'initialization-failure') {
        await assert.rejects(root.closed, (error) => error === failure)
      } else await root.closed

      assert.throws(
        () => context.onCleanup(() => lateCleanups++),
        (error) => error instanceof NativeStateError && error.code === 'invalid_state'
      )
      if (mode === 'framework-failure' || mode === 'initialization-failure') {
        await assert.rejects(root.dispose(), (error) => error === failure)
      } else await root.dispose()
      expect(cleanups).toBe(1)
      expect(lateCleanups).toBe(0)
      expect(root.diagnostics.nodes).toBe(0)
      expect(root.diagnostics.listeners).toBe(0)
    }))
}

test('framework cleanup cannot register another owner during synchronous teardown', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Reentrant cleanup registration' })
    let rejection: unknown
    let cleaned = 0
    let lateCleanups = 0
    const root = createRenderRoot(window, ({ onCleanup }) => {
      onCleanup(() => {
        cleaned++
        try {
          onCleanup(() => lateCleanups++)
        } catch (error) {
          rejection = error
        }
      })
    })
    await root.ready
    const disposing = root.dispose()
    expect(cleaned).toBe(1)
    expect(rejection).toBeInstanceOf(NativeStateError)
    assert.ok(rejection instanceof NativeStateError && rejection.code === 'invalid_state')
    await disposing
    await root.closed
    await root.dispose()
    expect(cleaned).toBe(1)
    expect(lateCleanups).toBe(0)
    expect(app.diagnostics.nodes).toBe(1)
  }))

test('invalid JavaScript cleanup values cannot consume or replace the registration', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Validated cleanup registration' })
    let context!: RenderContext
    const root = createRenderRoot(window, (value) => {
      context = value
    })
    await root.ready
    for (const value of [undefined, null, false, 0, 'cleanup', {}, []]) {
      assert.throws(() => Reflect.apply(context.onCleanup, undefined, [value]), TypeError)
    }
    let cleaned = 0
    context.onCleanup(() => cleaned++)
    for (const value of [undefined, null, false, 0, 'cleanup', {}, []]) {
      assert.throws(() => Reflect.apply(context.onCleanup, undefined, [value]), TypeError)
    }
    assert.throws(
      () => context.onCleanup(() => cleaned++),
      (error) => error instanceof NativeStateError && error.code === 'invalid_state'
    )
    await root.dispose()
    expect(cleaned).toBe(1)
    expect(app.diagnostics.nodes).toBe(1)
  }))
