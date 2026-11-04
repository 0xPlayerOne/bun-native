/** @jsxImportSource @bun-native/react */
import { expect, test } from 'bun:test'
import { render } from '@bun-native/react'
import { Workspace } from '../../examples/react-workspace/app.tsx'
import { visibleTasks, type WorkspaceState } from '../../examples/react-workspace/model.ts'
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
      window
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
