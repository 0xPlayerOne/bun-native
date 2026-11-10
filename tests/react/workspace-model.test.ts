import { describe, expect, test } from 'bun:test'
import {
  completedCount,
  createWorkspace,
  MAX_TASKS,
  MAX_TITLE_LENGTH,
  PLAN_INTERVAL_MS,
  PLAN_STEPS,
  schedulePlanStep,
  selectedPlan,
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
    expect(workspaceReducer(state, { type: 'plan-start' })).toBe(state)
    expect(selectedPlan(state)).toBeNull()
    state = workspaceReducer(state, { type: 'add', title: 'Start again' })
    expect(state.selectedId).toBe(state.tasks[0]!.id)
  })
  test('plans stream in order, complete once, and ignore stale or duplicate steps', () => {
    let state = workspaceReducer(createWorkspace(), { type: 'plan-start' })
    expect(state.plan).toEqual({
      id: 1,
      taskId: 2,
      steps: [],
      status: 'streaming',
    })
    expect(workspaceReducer(state, { type: 'plan-start' })).toBe(state)
    expect(workspaceReducer(state, { type: 'plan-step', id: 2 })).toBe(state)
    for (let index = 0; index < PLAN_STEPS.length; index++)
      state = workspaceReducer(state, { type: 'plan-step', id: 1 })
    expect(state.plan).toEqual({
      id: 1,
      taskId: 2,
      steps: [...PLAN_STEPS],
      status: 'complete',
    })
    expect(workspaceReducer(state, { type: 'plan-step', id: 1 })).toBe(state)
    expect(workspaceReducer(state, { type: 'plan-stop' })).toBe(state)
    state = workspaceReducer(state, { type: 'plan-start' })
    expect(state.plan).toEqual({
      id: 2,
      taskId: 2,
      steps: [],
      status: 'streaming',
    })
  })

  test('stop, selection, and additions keep partial steps while deleting a task drops its plan', () => {
    let state = workspaceReducer(createWorkspace(), { type: 'plan-start' })
    state = workspaceReducer(state, { type: 'plan-step', id: 1 })
    state = workspaceReducer(state, { type: 'plan-stop' })
    expect(state.plan).toEqual({
      id: 1,
      taskId: 2,
      steps: [PLAN_STEPS[0]],
      status: 'stopped',
    })
    expect(workspaceReducer(state, { type: 'plan-step', id: 1 })).toBe(state)

    state = workspaceReducer(state, { type: 'plan-start' })
    state = workspaceReducer(state, { type: 'select', id: 3 })
    expect(state.plan).toMatchObject({ id: 2, taskId: 2, status: 'stopped' })
    expect(selectedPlan(state)).toBeNull()
    state = workspaceReducer(state, { type: 'select', id: 2 })
    expect(selectedPlan(state)?.id).toBe(2)

    state = workspaceReducer(state, { type: 'plan-start' })
    state = workspaceReducer(state, { type: 'add', title: 'New work' })
    expect(state.plan).toMatchObject({ id: 3, taskId: 2, status: 'stopped' })

    // Deleting an unrelated, unselected task leaves a streaming plan running.
    state = workspaceReducer(state, { type: 'select', id: 2 })
    state = workspaceReducer(state, { type: 'plan-start' })
    state = workspaceReducer(state, { type: 'remove', id: 5 })
    expect(state.plan).toMatchObject({ id: 4, taskId: 2, status: 'streaming' })
    state = workspaceReducer(state, { type: 'remove', id: 2 })
    expect(state.plan).toBeNull()
    expect(state.selectedId).toBe(3)
    expect(workspaceReducer(state, { type: 'plan-step', id: 4 })).toBe(state)
  })

  test('the real plan timer fires once after its interval and cancellation prevents firing', async () => {
    let fired = 0
    let cancelledFired = 0
    const started = performance.now()
    let elapsed = 0
    schedulePlanStep(() => {
      fired++
      elapsed = performance.now() - started
    })
    const cancel = schedulePlanStep(() => {
      cancelledFired++
    })
    cancel()
    expect(fired).toBe(0)
    await Bun.sleep(PLAN_INTERVAL_MS * 2)
    expect(fired).toBe(1)
    expect(elapsed).toBeGreaterThanOrEqual(PLAN_INTERVAL_MS - 1)
    expect(cancelledFired).toBe(0)
  })
})

describe('React workspace in-app clear confirmation', () => {
  test('only an open confirmation clears, and dismissing keeps every task', () => {
    let state = createWorkspace()
    expect(completedCount(state)).toBe(1)
    expect(workspaceReducer(state, { type: 'clear-confirm' })).toBe(state)
    expect(workspaceReducer(state, { type: 'clear-dismiss' })).toBe(state)
    state = workspaceReducer(state, { type: 'clear-request' })
    expect(state.confirmingClear).toBe(true)
    expect(workspaceReducer(state, { type: 'clear-request' })).toBe(state)
    state = workspaceReducer(state, { type: 'clear-dismiss' })
    expect(state.confirmingClear).toBe(false)
    expect(state.tasks).toHaveLength(12)
  })

  test('nothing to clear opens nothing', () => {
    let state = workspaceReducer(createWorkspace(), { type: 'toggle', id: 1 })
    expect(completedCount(state)).toBe(0)
    expect(workspaceReducer(state, { type: 'clear-request' })).toBe(state)
    state = workspaceReducer(state, { type: 'toggle', id: 4 })
    expect(workspaceReducer(state, { type: 'clear-request' }).confirmingClear).toBe(true)
  })

  test('clearing keeps a surviving selection and its plan, ids and order', () => {
    let state = createWorkspace()
    state = workspaceReducer(state, { type: 'toggle', id: 3 })
    state = workspaceReducer(state, { type: 'plan-start' })
    state = workspaceReducer(state, { type: 'plan-step', id: 1 })
    state = workspaceReducer(state, { type: 'clear-request' })
    state = workspaceReducer(state, { type: 'clear-confirm' })
    expect(state.tasks.map((task) => task.id)).toEqual([2, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(state.selectedId).toBe(2)
    expect(state.plan).toEqual({ id: 1, taskId: 2, steps: [PLAN_STEPS[0]], status: 'streaming' })
    expect(state.confirmingClear).toBe(false)
    expect(state.nextId).toBe(13)
    // A second confirmation queued behind the first is inert.
    expect(workspaceReducer(state, { type: 'clear-confirm' })).toBe(state)
  })

  test('clearing the selected task drops its plan and selects the first remaining task', () => {
    let state = createWorkspace()
    state = workspaceReducer(state, { type: 'toggle', id: 2 })
    state = workspaceReducer(state, { type: 'plan-start' })
    state = workspaceReducer(state, { type: 'clear-request' })
    state = workspaceReducer(state, { type: 'clear-confirm' })
    expect(state.selectedId).toBe(3)
    expect(state.plan).toBeNull()
    expect(selectedPlan(state)).toBeNull()
  })

  test('clearing every task leaves an empty, unselected workspace', () => {
    let state = createWorkspace()
    for (const task of state.tasks)
      if (!task.completed) state = workspaceReducer(state, { type: 'toggle', id: task.id })
    state = workspaceReducer(state, { type: 'clear-request' })
    state = workspaceReducer(state, { type: 'clear-confirm' })
    expect(state.tasks).toEqual([])
    expect(state.selectedId).toBeNull()
    expect(workspaceReducer(state, { type: 'clear-request' })).toBe(state)
  })
})
