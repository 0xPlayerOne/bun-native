/** @jsxImportSource @bun-native/react */
import type { ConfirmDialogOptions, InputState, KeyEvent } from '@bun-native/core'
import { focusNode, inputState, type JSX, type NativeRef } from '@bun-native/react'
import { useEffect, useReducer, useRef, useState, type Dispatch } from 'react'
import {
  completedCount,
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
import { MAX_COMMAND_LENGTH, type TerminalSession, type TerminalState } from '../shared/terminal.ts'

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

/** An unmodified Escape; with any modifier it is an ordinary key. */
function isEscape(event: KeyEvent): boolean {
  const { control, alt, shift, platform, function: fn } = event.modifiers
  return event.key === 'escape' && !control && !alt && !shift && !platform && !fn
}

/**
 * The in-app confirmation for clearing completed tasks. It is the app's own UI,
 * drawn as a modal window overlay: the host traps Tab inside it, focuses its
 * first control (the safe "Keep" choice) and returns focus to the control that
 * opened it when it closes. Escape and a press on the backdrop keep the tasks.
 */
function ClearCompletedPanel({
  count,
  palette,
  dispatch,
  onConfirm,
}: {
  count: number
  palette: Palette
  dispatch: Dispatch<WorkspaceAction>
  onConfirm: () => void
}): JSX.Element {
  const noun = count === 1 ? 'task' : 'tasks'
  return (
    <overlay
      modal
      accessibleLabel="Clear completed tasks"
      style={{ align_items: 'center', justify_content: 'center' }}
      onKeyDown={(event) => {
        if (!isEscape(event)) return
        event.stopPropagation()
        dispatch({ type: 'clear-dismiss' })
      }}
      onPointerDown={(event) => {
        // A press on the backdrop targets the overlay itself, not a descendant.
        if (event.phase === 'target') dispatch({ type: 'clear-dismiss' })
      }}
    >
      <box style={{ padding: 2, background: palette.muted }}>
        <box
          style={{
            direction: 'column',
            gap: 12,
            padding: 20,
            width: 380,
            background: palette.panel,
          }}
        >
          <text style={{ color: palette.text, font_size: 20 }}>Clear completed tasks?</text>
          <text style={{ color: palette.muted }}>
            {`Remove ${count} completed ${noun} from this session. This cannot be undone.`}
          </text>
          <text style={{ color: palette.muted }}>
            In-app confirmation · Tab moves between choices · Escape keeps them.
          </text>
          <box style={{ direction: 'row', gap: 8, height: 40 }}>
            <button
              text="Keep tasks"
              style={{
                width: 0,
                flex_grow: 1,
                color: palette.text,
                background: palette.background,
              }}
              onClick={() => dispatch({ type: 'clear-dismiss' })}
            />
            <button
              text={`Clear ${count} ${noun}`}
              style={{ width: 0, flex_grow: 1, color: palette.text, background: palette.accent }}
              onClick={onConfirm}
            />
          </box>
        </box>
      </box>
    </overlay>
  )
}

/**
 * Asks the user to confirm a destructive action. The window's own
 * `showConfirmDialog` satisfies it; the host draws the question on the modal
 * overlay, so the workspace never simulates a dialog itself.
 */
export type ConfirmAction = (options: ConfirmDialogOptions) => Promise<boolean>

function TaskDetails({
  task,
  plan,
  palette,
  dispatch,
  confirm,
}: {
  task: Task
  plan: Plan | null
  palette: Palette
  dispatch: Dispatch<WorkspaceAction>
  confirm?: ConfirmAction | undefined
}): JSX.Element {
  const streaming = plan?.status === 'streaming'
  const reference = useRef<NativeRef>(null)
  const [title, setTitle] = useState<InputState>({ value: task.title, revision: 0 })
  const validTitle = taskTitle(title.value)
  // This component is keyed by task, so an answer that arrives after the task
  // was deselected or the window closed finds it unmounted and does nothing.
  const mounted = useRef(true)
  const asking = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  function remove() {
    if (!confirm) return dispatch({ type: 'remove', id: task.id })
    // The dialog is modal, so a second press cannot arrive while it is shown.
    if (asking.current) return
    asking.current = true
    const id = task.id
    void confirm({
      title: 'Delete task?',
      message: `Delete “${task.title}”? This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Keep task',
      destructive: true,
    }).then((accepted) => {
      asking.current = false
      if (accepted && mounted.current) dispatch({ type: 'remove', id })
    })
  }
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
        onClick={remove}
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

function terminalStatus(state: TerminalState): string {
  switch (state.status) {
    case 'running':
      return 'Shell running on a pseudo-terminal'
    case 'starting':
      return 'Starting shell…'
    case 'exited':
      return 'Shell ended (' + state.detail + ')'
    case 'failed':
      return 'Shell failed to start: ' + state.detail
    default:
      return 'No shell running'
  }
}

/** The same owned shell session as the Solid workspace, rendered by React. */
function TerminalPanel({
  session,
  palette,
}: {
  session: TerminalSession
  palette: Palette
}): JSX.Element {
  const [terminal, setTerminal] = useState<TerminalState>(session.current)
  useEffect(() => {
    setTerminal(session.current)
    return session.subscribe(setTerminal)
  }, [session])
  const [command, setCommand] = useState<InputState>({ value: '', revision: 0 })
  const field = useRef<NativeRef>(null)
  const running = terminal.status === 'running'

  function run() {
    if (!field.current) return
    const observed = inputState(field.current)
    if (!running || observed.value.length > MAX_COMMAND_LENGTH) return
    setCommand({ value: '', revision: observed.revision })
    void session.run(observed.value)
  }

  return (
    <box style={{ direction: 'column', gap: 8, padding: 20, flex_shrink: 0 }}>
      <text style={{ color: palette.text, font_size: 18 }}>Terminal</text>
      <text style={{ color: palette.muted, font_size: 12 }}>{terminalStatus(terminal)}</text>
      <box
        style={{
          direction: 'column',
          padding: 8,
          height: 220,
          flex_shrink: 0,
          overflow: 'scroll_y',
          scroll_anchor: 'end',
          background: palette.background,
        }}
      >
        {terminal.lines.map((line) => (
          <text key={line.id} style={{ color: palette.text, font_size: 13, width: 'fill' }}>
            {line.text || ' '}
          </text>
        ))}
        <text style={{ color: palette.text, font_size: 13, width: 'fill' }}>
          {terminal.partial || ' '}
        </text>
      </box>
      <input
        ref={field}
        value={command}
        placeholder="Type a command and press Enter"
        disabled={!running}
        style={{ height: 36, width: 'fill', color: palette.text, background: palette.background }}
        onInput={setCommand}
        onKeyDown={(event) => {
          if (event.key === 'enter') run()
        }}
      />
      <box style={{ direction: 'row', gap: 8, height: 34 }}>
        <button
          text="Interrupt"
          disabled={!running}
          style={{
            width: 100,
            color: running ? palette.text : palette.muted,
            background: palette.accent,
          }}
          onClick={() => void session.interrupt()}
        />
        <button
          text="Restart shell"
          style={{ width: 120, color: palette.text, background: palette.accent }}
          onClick={() => void session.restart()}
        />
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
  confirm,
  onDispatch,
  terminal,
}: {
  onChange?: (state: WorkspaceState) => void
  /**
   * Qualification only: receives the component's own reducer dispatch, so a
   * long-session fixture can drive the same actions its controls dispatch.
   */
  onDispatch?: (dispatch: Dispatch<WorkspaceAction>) => void
  schedule?: PlanScheduler
  /** When given, deleting a task asks first. Without it the delete is immediate. */
  confirm?: ConfirmAction | undefined
  /** A live shell for the details pane. Without one, the pane shows only the task. */
  terminal?: TerminalSession | undefined
}): JSX.Element {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, createWorkspace)
  const [draft, setDraft] = useState<InputState>({ value: '', revision: 0 })
  const [search, setSearch] = useState<InputState>({ value: '', revision: 0 })
  const composer = useRef<NativeRef>(null)
  const searchInput = useRef<NativeRef>(null)
  const palette = palettes[state.theme]
  const visible = visibleTasks(state)
  const selected = state.tasks.find((task) => task.id === state.selectedId)
  const completed = completedCount(state)
  const canAdd = state.tasks.length < MAX_TASKS && taskTitle(draft.value) !== undefined
  const plan = selectedPlan(state)
  const streamingPlan = state.plan?.status === 'streaming' ? state.plan : null
  useEffect(() => onChange?.(state), [onChange, state])
  useEffect(() => onDispatch?.(dispatch), [onDispatch])
  // Keep, Escape and the backdrop return focus natively to the control that
  // opened the panel. A confirmed clear disables that control, so focus moves
  // to the composer once the panel has left the native tree.
  const refocusComposer = useRef(false)
  useEffect(() => {
    if (state.confirmingClear || !refocusComposer.current) return
    refocusComposer.current = false
    // The window can close first; there is nothing left to focus then.
    if (composer.current) void focusNode(composer.current).catch(() => {})
  }, [state.confirmingClear])
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
          text={`Clear completed (${completed})`}
          disabled={completed === 0}
          style={{
            width: 180,
            height: 40,
            color: completed ? palette.text : palette.muted,
            background: palette.panel,
          }}
          onClick={() => dispatch({ type: 'clear-request' })}
        />
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
            width: terminal ? 380 : 300,
            flex_shrink: 0,
            overflow: 'scroll_y',
            background: palette.panel,
          }}
        >
          {terminal ? <TerminalPanel session={terminal} palette={palette} /> : null}
          {selected ? (
            <TaskDetails
              key={selected.id}
              task={selected}
              plan={plan}
              palette={palette}
              dispatch={dispatch}
              confirm={confirm}
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
      {state.confirmingClear ? (
        <ClearCompletedPanel
          count={completed}
          palette={palette}
          dispatch={dispatch}
          onConfirm={() => {
            refocusComposer.current = true
            dispatch({ type: 'clear-confirm' })
          }}
        />
      ) : null}
    </box>
  )
}
