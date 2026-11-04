import { describe, expect, test } from 'bun:test'
import {
  createWorkspace,
  MAX_TASKS,
  MAX_TITLE_LENGTH,
  visibleTasks,
  workspaceReducer,
} from '../../examples/react-workspace/model.ts'

describe('React workspace task workflows', () => {
  test('adding from a filtered view reveals and selects the normalized task', () => {
    let state = createWorkspace()
    state = workspaceReducer(state, { type: 'filter', filter: 'completed' })
    state = workspaceReducer(state, { type: 'search', query: 'does not match' })
    expect(visibleTasks(state)).toHaveLength(0)
    state = workspaceReducer(state, { type: 'add', title: '  Ship the workspace  ' })
    expect(visibleTasks(state)[0]).toEqual({
      id: 13,
      title: 'Ship the workspace',
      completed: false,
    })
    expect(state.query).toBe('')
    expect(state.filter).toBe('all')
    expect(state.selectedId).toBe(13)
  })

  test('completion, rename, search, and deletion preserve stable identities and selection', () => {
    let state = createWorkspace()
    const originalFirst = state.tasks[0]!
    state = workspaceReducer(state, { type: 'select', id: 3 })
    state = workspaceReducer(state, {
      type: 'rename',
      id: 3,
      title: ' Review native keyboard input ',
    })
    state = workspaceReducer(state, { type: 'toggle', id: 3 })
    state = workspaceReducer(state, { type: 'filter', filter: 'completed' })
    state = workspaceReducer(state, { type: 'search', query: ' KEYBOARD ' })
    expect(visibleTasks(state)).toEqual([
      { id: 3, title: 'Review native keyboard input', completed: true },
    ])
    expect(state.tasks[0]).toBe(originalFirst)
    state = workspaceReducer(state, { type: 'remove', id: 3 })
    expect(state.selectedId).toBe(4)
    expect(visibleTasks(state)).toHaveLength(0)
    state = workspaceReducer(state, { type: 'add', title: 'New identity' })
    expect(state.selectedId).toBe(13)
    expect(new Set(state.tasks.map((task) => task.id)).size).toBe(state.tasks.length)
  })

  test('invalid edits and stale actions cannot corrupt task data or selection', () => {
    const state = createWorkspace()
    for (const title of ['', ' \t ', 'a'.repeat(MAX_TITLE_LENGTH + 1)]) {
      expect(workspaceReducer(state, { type: 'add', title })).toBe(state)
      expect(workspaceReducer(state, { type: 'rename', id: 2, title })).toBe(state)
    }
    expect(workspaceReducer(state, { type: 'select', id: 999 })).toBe(state)
    expect(workspaceReducer(state, { type: 'remove', id: 999 })).toBe(state)
    expect(workspaceReducer(state, { type: 'toggle', id: 999 })).toBe(state)
    expect(workspaceReducer(state, { type: 'rename', id: 999, title: 'Missing task' })).toBe(state)
  })

  test('capacity is bounded, deletions release capacity, and the last deletion clears selection', () => {
    let state = createWorkspace()
    while (state.tasks.length < MAX_TASKS)
      state = workspaceReducer(state, { type: 'add', title: `Task ${state.nextId}` })
    expect(workspaceReducer(state, { type: 'add', title: 'Overflow' })).toBe(state)
    const oldLastId = state.nextId - 1
    state = workspaceReducer(state, { type: 'remove', id: oldLastId })
    state = workspaceReducer(state, { type: 'add', title: 'Replacement' })
    expect(state.tasks).toHaveLength(MAX_TASKS)
    expect(state.selectedId).toBe(oldLastId + 1)
    for (const task of state.tasks) state = workspaceReducer(state, { type: 'remove', id: task.id })
    expect(state.tasks).toHaveLength(0)
    expect(state.selectedId).toBeNull()
    state = workspaceReducer(state, { type: 'add', title: 'Start again' })
    expect(state.selectedId).toBe(state.tasks[0]!.id)
  })
})
