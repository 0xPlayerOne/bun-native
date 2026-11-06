/** @jsxImportSource @bun-native/react */
import type { InputState } from '@bun-native/core'
import { inputState, type JSX, type NativeRef } from '@bun-native/react'
import { useEffect, useReducer, useRef, useState, type Dispatch } from 'react'
import {
  createWorkspace,
  MAX_TASKS,
  MAX_TITLE_LENGTH,
  PLAN_STEPS,
  schedulePlanStep,
  selectedPlan,
  taskTitle,
  visibleTasks,
  workspaceReducer,
  type Plan,
  type PlanScheduler,
  type Task,
  type TaskFilter,
  type WorkspaceAction,
  type WorkspaceState,
} from './model.ts'

const palettes = {
  light: {
    background: 0xf3f5f8,
    panel: 0xffffff,
    text: 0x182230,
    muted: 0x526174,
    accent: 0xdce9ff,
  },
  dark: {
    background: 0x151b24,
    panel: 0x222d3c,
    text: 0xeaf0f8,
    muted: 0xb3c0d2,
    accent: 0x344e74,
  },
}
type Palette = (typeof palettes)['light']
const filters: readonly { value: TaskFilter; label: string }[] = [
  { value: 'all', label: 'All tasks' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
]

function planStatus(plan: Plan | null): string {
  if (!plan) return 'Draft a local plan. Nothing is sent anywhere.'
  const progress = `${plan.steps.length} of ${PLAN_STEPS.length} steps`
  if (plan.status === 'streaming') return `Drafting locally · ${progress}`
  return plan.status === 'complete' ? `Plan ready · ${progress}` : `Plan stopped · ${progress}`
}

function TaskDetails({
  task,
  plan,
  palette,
  dispatch,
}: {
  task: Task
  plan: Plan | null
  palette: Palette
  dispatch: Dispatch<WorkspaceAction>
}): JSX.Element {
  const streaming = plan?.status === 'streaming'
  const reference = useRef<NativeRef>(null)
  const [title, setTitle] = useState<InputState>({ value: task.title, revision: 0 })
  const validTitle = taskTitle(title.value)
  function save() {
    if (!reference.current) return
    const observed = inputState(reference.current)
    const nextTitle = taskTitle(observed.value)
    if (!nextTitle) return
    dispatch({ type: 'rename', id: task.id, title: nextTitle })
    setTitle({ value: nextTitle, revision: observed.revision })
  }
  return (
    <box style={{ direction: 'column', gap: 12, padding: 20 }}>
      <text style={{ color: palette.text, font_size: 22 }}>Task details</text>
      <text style={{ color: palette.muted }}>
        Task {task.id} · {task.completed ? 'Completed' : 'Active'}
      </text>
      <text style={{ color: palette.text }}>Title</text>
      <input
        ref={reference}
        value={title}
        placeholder="Task title"
        style={{ width: 'fill', height: 40, color: palette.text, background: palette.background }}
        onInput={setTitle}
        onKeyDown={(event) => {
          if (event.key === 'enter') save()
        }}
      />
      <button
        text="Save title"
        disabled={!validTitle || validTitle === task.title}
        style={{
          height: 40,
          color: validTitle && validTitle !== task.title ? palette.text : palette.muted,
          background: validTitle && validTitle !== task.title ? palette.accent : palette.background,
        }}
        onClick={save}
      />
      <text style={{ color: palette.muted }}>
        {validTitle ? 'Press Enter or Save title.' : `Use 1–${MAX_TITLE_LENGTH} characters.`}
      </text>
      <button
        text="Delete task"
        style={{ height: 40, color: palette.text, background: palette.background }}
        onClick={() => dispatch({ type: 'remove', id: task.id })}
      />
      <text style={{ color: palette.text, font_size: 18 }}>Plan</text>
      <button
        text={streaming ? 'Stop plan' : plan ? 'Draft a new plan' : 'Draft a plan'}
        style={{
          height: 40,
          color: palette.text,
          background: streaming ? palette.background : palette.accent,
        }}
        onClick={() => dispatch({ type: streaming ? 'plan-stop' : 'plan-start' })}
      />
      <text style={{ color: palette.muted }}>{planStatus(plan)}</text>
      <box style={{ direction: 'column', gap: 6 }}>
        {plan?.steps.map((step, index) => (
          // Steps are append-only, so the position is a stable identity.
          <text key={index} style={{ color: palette.text }}>
            {`${index + 1}. ${step}`}
          </text>
        ))}
      </box>
    </box>
  )
}

/**
 * The same component runs in development, AOT, and the public-adapter contract
 * tests. `schedule` defaults to a real timer; tests may observe its ownership.
 */
export function Workspace({
  onChange,
  schedule = schedulePlanStep,
}: {
  onChange?: (state: WorkspaceState) => void
  schedule?: PlanScheduler
}): JSX.Element {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, createWorkspace)
  const [draft, setDraft] = useState<InputState>({ value: '', revision: 0 })
  const [search, setSearch] = useState<InputState>({ value: '', revision: 0 })
  const composer = useRef<NativeRef>(null)
  const searchInput = useRef<NativeRef>(null)
  const palette = palettes[state.theme]
  const visible = visibleTasks(state)
  const selected = state.tasks.find((task) => task.id === state.selectedId)
  const completed = state.tasks.filter((task) => task.completed).length
  const canAdd = state.tasks.length < MAX_TASKS && taskTitle(draft.value) !== undefined
  const plan = selectedPlan(state)
  const streamingPlan = state.plan?.status === 'streaming' ? state.plan : null
  useEffect(() => onChange?.(state), [onChange, state])
  // At most one timer is live. Every step, stop, selection change or unmount
  // cancels it through this cleanup; the reducer also ignores stale plan IDs.
  useEffect(() => {
    if (!streamingPlan) return
    const id = streamingPlan.id
    return schedule(() => dispatch({ type: 'plan-step', id }))
  }, [streamingPlan, schedule])

  function addTask() {
    if (!composer.current || state.tasks.length >= MAX_TASKS) return
    // Read the latest observed native edit at activation, before replacing its text.
    const observed = inputState(composer.current)
    const title = taskTitle(observed.value)
    if (!title) return
    dispatch({ type: 'add', title })
    setDraft({ value: '', revision: observed.revision })
    if (searchInput.current) {
      const observedSearch = inputState(searchInput.current)
      setSearch({ value: '', revision: observedSearch.revision })
    }
  }

  return (
    <box
      style={{
        direction: 'column',
        width: 'fill',
        height: 'fill',
        padding: 24,
        gap: 16,
        background: palette.background,
      }}
    >
      <box style={{ direction: 'row', align_items: 'center', gap: 16, height: 44, flex_shrink: 0 }}>
        <text style={{ font_size: 28, color: palette.text, flex_grow: 1 }}>Project workspace</text>
        <button
          text={state.theme === 'light' ? 'Use dark theme' : 'Use light theme'}
          style={{ width: 160, height: 40, color: palette.text, background: palette.panel }}
          onClick={() => dispatch({ type: 'theme' })}
        />
      </box>
      <text style={{ color: palette.muted, height: 24, flex_shrink: 0 }}>
        {state.tasks.length - completed} active · {completed} completed · Changes last for this
        session
      </text>
      <box style={{ direction: 'row', gap: 12, height: 44, flex_shrink: 0 }}>
        <input
          ref={composer}
          value={draft}
          placeholder="Add a task"
          style={{
            width: 0,
            flex_grow: 1,
            min_width: 0,
            color: palette.text,
            background: palette.panel,
          }}
          onInput={setDraft}
          onKeyDown={(event) => {
            if (event.key === 'enter') addTask()
          }}
        />
        <button
          text="Add task"
          disabled={!canAdd}
          style={{
            width: 120,
            flex_shrink: 0,
            color: canAdd ? palette.text : palette.muted,
            background: canAdd ? palette.accent : palette.panel,
          }}
          onClick={addTask}
        />
      </box>
      <box style={{ direction: 'row', gap: 8, height: 40, flex_shrink: 0 }}>
        {filters.map((filter) => (
          <button
            key={filter.value}
            text={filter.label}
            style={{
              width: 112,
              flex_shrink: 0,
              color: palette.text,
              background: state.filter === filter.value ? palette.accent : palette.panel,
            }}
            onClick={() => dispatch({ type: 'filter', filter: filter.value })}
          />
        ))}
        <input
          ref={searchInput}
          value={search}
          placeholder="Search tasks"
          style={{
            width: 0,
            flex_grow: 1,
            min_width: 0,
            color: palette.text,
            background: palette.panel,
          }}
          onInput={(event) => {
            setSearch(event)
            dispatch({ type: 'search', query: event.value })
          }}
        />
      </box>
      <box style={{ direction: 'row', gap: 16, height: 0, flex_grow: 1, min_height: 0 }}>
        <box
          style={{
            direction: 'column',
            gap: 8,
            padding: 12,
            width: 0,
            flex_grow: 1,
            min_width: 200,
            overflow: 'scroll_y',
            background: palette.panel,
          }}
        >
          {visible.length === 0 ? (
            <text style={{ color: palette.muted }}>No tasks match this view.</text>
          ) : (
            visible.map((task) => (
              <box key={task.id} style={{ direction: 'row', gap: 8, height: 56, flex_shrink: 0 }}>
                <button
                  text={task.completed ? 'Reopen' : 'Complete'}
                  style={{
                    width: 92,
                    flex_shrink: 0,
                    color: palette.text,
                    background: palette.background,
                  }}
                  onClick={() => dispatch({ type: 'toggle', id: task.id })}
                />
                <button
                  text={task.title}
                  style={{
                    width: 0,
                    flex_grow: 1,
                    min_width: 0,
                    overflow: 'hidden',
                    color: palette.text,
                    background: task.id === state.selectedId ? palette.accent : palette.background,
                  }}
                  onClick={() => dispatch({ type: 'select', id: task.id })}
                />
              </box>
            ))
          )}
        </box>
        <box
          style={{
            direction: 'column',
            width: 300,
            flex_shrink: 0,
            overflow: 'scroll_y',
            background: palette.panel,
          }}
        >
          {selected ? (
            <TaskDetails
              key={selected.id}
              task={selected}
              plan={plan}
              palette={palette}
              dispatch={dispatch}
            />
          ) : (
            <text style={{ padding: 20, color: palette.muted }}>Add a task to get started.</text>
          )}
        </box>
      </box>
      <text style={{ color: palette.muted, height: 24, flex_shrink: 0 }}>
        {state.tasks.length >= MAX_TASKS
          ? `This workspace holds up to ${MAX_TASKS} tasks. Delete a task to add another.`
          : draft.value && !taskTitle(draft.value)
            ? `Use 1–${MAX_TITLE_LENGTH} characters for a task title.`
            : `${visible.length} tasks shown · Select a task to edit its title`}
      </text>
    </box>
  )
}
