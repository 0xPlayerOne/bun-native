/** @jsxImportSource @bun-native/react */
import { expect, test } from 'bun:test'
import { render } from '@bun-native/react'
import { Workspace } from '../../examples/react-workspace/app.tsx'
import {
  PLAN_STEPS,
  visibleTasks,
  type PlanScheduler,
  type WorkspaceState,
} from '../../examples/react-workspace/model.ts'
import { observeWindow, withApp } from '../renderers/support.ts'
import { until } from './support.ts'

test('workspace public adapter supports editing, filtering, themes, and window teardown', () =>
  withApp(async (app) => {
    const actual = await app.openWindow({ title: 'Workspace contract' })
    const marker = await actual.batch((batch) => {
      const node = batch.create({ kind: 'text', text: 'Marker' })
      batch.append(actual.root, node)
      return node
    })
    const { window, observations } = observeWindow(actual)
    let state: WorkspaceState | undefined
    let changes = 0
    const root = render(
      <Workspace
        onChange={(next) => {
          state = next
          changes++
        }}
      />,
      window,
      { style: { width: 'fill', height: 'fill' } }
    )
    async function event(type: 'click' | 'input' | 'key_down', target: string) {
      const before = changes
      const input =
        type === 'input'
          ? target === 'Add a task'
            ? observations.inputs[0]!
            : target === 'Search tasks'
              ? observations.inputs[1]!
              : observations.inputs.at(-1)!
          : undefined
      const revision = input ? actual.input(input).revision : 0
      await actual.batch((batch) =>
        batch.set(marker, {
          kind: 'text',
          text: `event:${JSON.stringify({ type, target })}`,
        })
      )
      if (input)
        await until(
          () =>
            actual.input(input).revision > revision &&
            app.diagnostics.activeCallbacks === 0 &&
            app.diagnostics.queuedCallbacks === 0
        )
      else await until(() => changes > before)
      await root.flush()
    }
    try {
      await root.ready
      expect(state?.tasks).toHaveLength(12)
      await event('input', 'Add a task')
      await event('key_down', 'Add a task')
      expect(state?.tasks[0]?.title).toBe('native edit')
      expect(state?.selectedId).toBe(13)
      expect(actual.input(observations.inputs[0]!).value).toBe('')

      await event('click', 'Complete')
      expect(state?.tasks.find((task) => task.id === 2)?.completed).toBe(true)
      await event('click', 'Completed')
      expect(visibleTasks(state!)).toHaveLength(2)
      await event('click', 'Write the project brief')
      expect(state?.selectedId).toBe(1)
      await event('input', 'Task title')
      await event('click', 'Save title')
      expect(state?.tasks.find((task) => task.id === 1)?.title).toBe('native edit')

      await event('click', 'Use dark theme')
      expect(state?.theme).toBe('dark')
      await event('input', 'Search tasks')
      expect(visibleTasks(state!)).toHaveLength(1)
      await event('click', 'Delete task')
      expect(state?.tasks.some((task) => task.id === 1)).toBe(false)
      expect(state?.selectedId).toBe(2)
      await actual.close()
      await root.closed
      expect(root.diagnostics.nodes).toBe(0)
      expect(root.diagnostics.listeners).toBe(0)
      expect(app.diagnostics.callbacks).toBe(0)
    } finally {
      await root.dispose()
    }
  }, 'events-peer.ts'))

test('workspace submits one task when Enter is queued during the native input clear', () =>
  withApp(async (app) => {
    const actual = await app.openWindow({ title: 'Workspace repeated submission' })
    const marker = await actual.batch((batch) => {
      const node = batch.create({ kind: 'text', text: 'Marker' })
      batch.append(actual.root, node)
      return node
    })
    const { window, observations } = observeWindow(actual)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let holdNextCommit = false
    window.batch = async (operation) => {
      if (holdNextCommit) {
        holdNextCommit = false
        entered.resolve()
        await release.promise
      }
      return actual.batch(operation)
    }
    let state: WorkspaceState | undefined
    let keys = 0
    actual.on(
      actual.root,
      'key_down',
      () => {
        keys++
      },
      { capture: true }
    )
    const root = render(
      <Workspace
        onChange={(next) => {
          state = next
        }}
      />,
      window
    )
    const emit = (type: 'input' | 'key_down') =>
      actual.batch((batch) =>
        batch.set(marker, {
          kind: 'text',
          text: `event:${JSON.stringify({ type, target: 'Add a task' })}`,
        })
      )
    try {
      await root.ready
      await emit('input')
      await until(
        () =>
          actual.input(observations.inputs[0]!).revision > 0 &&
          app.diagnostics.activeCallbacks === 0 &&
          app.diagnostics.queuedCallbacks === 0
      )
      await root.flush()
      holdNextCommit = true
      await emit('key_down')
      await entered.promise
      expect(actual.input(observations.inputs[0]!).value).toBe('native edit')
      await emit('key_down')
      await until(() => app.diagnostics.queuedCallbacks > 0)
      release.resolve()
      await until(
        () =>
          keys === 2 &&
          app.diagnostics.activeCallbacks === 0 &&
          app.diagnostics.queuedCallbacks === 0
      )
      await root.flush()
      expect(state?.tasks).toHaveLength(13)
      expect(state?.nextId).toBe(14)
      expect(actual.input(observations.inputs[0]!).value).toBe('')
    } finally {
      release.resolve()
      await root.dispose()
    }
  }, 'events-peer.ts'))

test('workspace plan stream owns one timer through stop, selection, and window close', () =>
  withApp(async (app) => {
    const actual = await app.openWindow({ title: 'Workspace plan stream' })
    const marker = await actual.batch((batch) => {
      const node = batch.create({ kind: 'text', text: 'Marker' })
      batch.append(actual.root, node)
      return node
    })
    const pending = new Set<() => void>()
    const timers = { scheduled: 0, fired: 0, cancelled: 0 }
    const schedule: PlanScheduler = (callback) => {
      timers.scheduled++
      pending.add(callback)
      return () => {
        if (pending.delete(callback)) timers.cancelled++
      }
    }
    let state: WorkspaceState | undefined
    let changes = 0
    const root = render(
      <Workspace
        schedule={schedule}
        onChange={(next) => {
          state = next
          changes++
        }}
      />,
      actual,
      { style: { width: 'fill', height: 'fill' } }
    )
    async function click(target: string) {
      const before = changes
      await actual.batch((batch) =>
        batch.set(marker, {
          kind: 'text',
          text: `event:${JSON.stringify({ type: 'click', target })}`,
        })
      )
      await until(() => changes > before)
      await root.flush()
    }
    async function step() {
      const [callback] = pending
      expect(pending.size).toBe(1)
      pending.delete(callback!)
      timers.fired++
      callback!()
      await root.flush()
      await until(() => state?.plan?.status !== 'streaming' || pending.size === 1)
    }
    try {
      await root.ready
      expect(state?.selectedId).toBe(2)
      await click('Draft a plan')
      expect(state?.plan).toEqual({
        id: 1,
        taskId: 2,
        steps: [],
        status: 'streaming',
      })
      for (let index = 0; index < PLAN_STEPS.length; index++) await step()
      expect(state?.plan).toEqual({
        id: 1,
        taskId: 2,
        steps: [...PLAN_STEPS],
        status: 'complete',
      })
      expect(pending.size).toBe(0)

      await click('Draft a new plan')
      await step()
      await step()
      await click('Stop plan')
      expect(state?.plan).toMatchObject({
        id: 2,
        status: 'stopped',
        steps: PLAN_STEPS.slice(0, 2),
      })
      expect(pending.size).toBe(0)

      await click('Draft a new plan')
      await step()
      await click('Write the project brief')
      expect(state?.selectedId).toBe(1)
      expect(state?.plan).toMatchObject({
        id: 3,
        taskId: 2,
        status: 'stopped',
      })
      expect(pending.size).toBe(0)

      // A callback that was already queued when its plan stopped cannot write.
      await click('Draft a plan')
      const [stale] = pending
      await click('Stop plan')
      stale!()
      await root.flush()
      expect(state?.plan).toMatchObject({
        id: 4,
        taskId: 1,
        steps: [],
        status: 'stopped',
      })

      await click('Draft a new plan')
      await step()
      expect(state?.plan).toMatchObject({
        id: 5,
        status: 'streaming',
        steps: [PLAN_STEPS[0]],
      })
      await actual.close()
      await root.closed
      expect(pending.size).toBe(0)
      expect(timers.scheduled).toBe(timers.fired + timers.cancelled)
      expect(timers.cancelled).toBe(4)
      expect(root.diagnostics.nodes).toBe(0)
      expect(root.diagnostics.listeners).toBe(0)
      expect(app.diagnostics.callbacks).toBe(0)
    } finally {
      await root.dispose()
    }
  }, 'events-peer.ts'))

test('workspace deletes every task through the empty state and adds the next one', () =>
  withApp(async (app) => {
    const actual = await app.openWindow({ title: 'Workspace empty state' })
    const marker = await actual.batch((batch) => {
      const node = batch.create({ kind: 'text', text: 'Marker' })
      batch.append(actual.root, node)
      return node
    })
    const { window, observations } = observeWindow(actual)
    // Record committed text labels without changing the forwarded batch.
    const texts = new Set<string>()
    window.batch = (operation) =>
      actual.batch((batch) =>
        operation(
          new Proxy(batch, {
            get(target, key) {
              const value = Reflect.get(target, key, target)
              if (typeof value !== 'function') return value
              return (...args: unknown[]) => {
                const element = (key === 'create' ? args[0] : key === 'set' ? args[1] : null) as {
                  kind: string
                  text?: string
                } | null
                if (element?.kind === 'text' && element.text !== undefined) texts.add(element.text)
                return value.apply(target, args)
              }
            },
          })
        )
      )
    let state: WorkspaceState | undefined
    let changes = 0
    const root = render(
      <Workspace
        onChange={(next) => {
          state = next
          changes++
        }}
      />,
      window,
      { style: { width: 'fill', height: 'fill' } }
    )
    async function emit(type: 'click' | 'input' | 'key_down', target: string) {
      const before = changes
      const input = type === 'input' ? observations.inputs[0]! : undefined
      const revision = input ? actual.input(input).revision : 0
      await actual.batch((batch) =>
        batch.set(marker, { kind: 'text', text: `event:${JSON.stringify({ type, target })}` })
      )
      if (input)
        await until(
          () =>
            actual.input(input).revision > revision &&
            app.diagnostics.activeCallbacks === 0 &&
            app.diagnostics.queuedCallbacks === 0
        )
      else await until(() => changes > before)
      await root.flush()
    }
    try {
      await root.ready
      expect(texts.has('Add a task to get started.')).toBe(false)
      const order = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1]
      for (const id of order) {
        expect(state?.selectedId).toBe(id)
        await emit('click', 'Delete task')
        expect(state?.tasks.some((task) => task.id === id)).toBe(false)
      }
      expect(state?.tasks).toHaveLength(0)
      expect(state?.selectedId).toBeNull()
      expect(texts.has('Add a task to get started.')).toBe(true)
      expect(texts.has('No tasks match this view.')).toBe(true)

      await emit('input', 'Add a task')
      await emit('key_down', 'Add a task')
      expect(state?.tasks).toEqual([{ id: 13, title: 'native edit', completed: false }])
      expect(state?.selectedId).toBe(13)
      await actual.close()
      await root.closed
      expect(root.diagnostics.nodes).toBe(0)
      expect(root.diagnostics.listeners).toBe(0)
      expect(app.diagnostics.callbacks).toBe(0)
    } finally {
      await root.dispose()
    }
  }, 'events-peer.ts'))
