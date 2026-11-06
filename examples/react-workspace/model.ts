export const MAX_TASKS = 200
export const MAX_TITLE_LENGTH = 120
export const PLAN_INTERVAL_MS = 300

/** Deterministic local plan text. No backend, model or network is contacted. */
export const PLAN_STEPS = [
  'Clarify the goal',
  'List what is already done',
  'Pick the first concrete change',
  'Note who needs to review it',
  'Decide how to check the result',
  'Estimate the remaining effort',
  'Flag anything that blocks progress',
  'Share the plan with the team',
] as const

export interface Task {
  readonly id: number
  readonly title: string
  readonly completed: boolean
}

export type TaskFilter = 'all' | 'active' | 'completed'
export type Theme = 'light' | 'dark'

/** One locally streamed plan. At most one plan exists, and only one can stream. */
export interface Plan {
  readonly id: number
  readonly taskId: number
  readonly steps: readonly string[]
  readonly status: 'streaming' | 'complete' | 'stopped'
}

/** Schedule one later callback and return its cancellation function. */
export type PlanScheduler = (callback: () => void) => () => void

export const schedulePlanStep: PlanScheduler = (callback) => {
  const timer = setTimeout(callback, PLAN_INTERVAL_MS)
  return () => clearTimeout(timer)
}

export interface WorkspaceState {
  readonly tasks: readonly Task[]
  readonly selectedId: number | null
  readonly filter: TaskFilter
  readonly query: string
  readonly theme: Theme
  readonly nextId: number
  readonly plan: Plan | null
  readonly nextPlanId: number
}

export type WorkspaceAction =
  | { type: 'add'; title: string }
  | { type: 'rename'; id: number; title: string }
  | { type: 'toggle'; id: number }
  | { type: 'select'; id: number }
  | { type: 'remove'; id: number }
  | { type: 'filter'; filter: TaskFilter }
  | { type: 'search'; query: string }
  | { type: 'theme' }
  | { type: 'plan-start' }
  | { type: 'plan-step'; id: number }
  | { type: 'plan-stop' }

export function taskTitle(value: string): string | undefined {
  const title = value.trim()
  return title.length > 0 && title.length <= MAX_TITLE_LENGTH ? title : undefined
}

export function createWorkspace(): WorkspaceState {
  const titles = [
    'Write the project brief',
    'Sketch the workspace navigation',
    'Review the native input flow',
    'Test keyboard navigation',
    'Check light and dark appearances',
    'Review empty and filtered states',
    'Measure the release build',
    'Try the app on a smaller display',
    'Collect feedback from a teammate',
    'Update the getting started guide',
    'Verify window close cleanup',
    'Prepare the next release',
  ]
  return {
    tasks: titles.map((title, index) => ({ id: index + 1, title, completed: index === 0 })),
    selectedId: 2,
    filter: 'all',
    query: '',
    theme: 'light',
    nextId: titles.length + 1,
    plan: null,
    nextPlanId: 1,
  }
}

/** The plan belonging to the selected task, if any. */
export function selectedPlan(state: WorkspaceState): Plan | null {
  return state.plan && state.plan.taskId === state.selectedId ? state.plan : null
}

function stopPlan(plan: Plan | null): Plan | null {
  return plan?.status === 'streaming' ? { ...plan, status: 'stopped' } : plan
}

/** Selection changes stop an unfinished plan, keeping its partial steps. */
function withSelection(state: WorkspaceState, selectedId: number | null): WorkspaceState {
  return selectedId === state.selectedId
    ? state
    : { ...state, selectedId, plan: stopPlan(state.plan) }
}

export function visibleTasks(state: WorkspaceState): readonly Task[] {
  const query = state.query.trim().toLowerCase()
  return state.tasks.filter(
    (task) =>
      (state.filter === 'all' || task.completed === (state.filter === 'completed')) &&
      task.title.toLowerCase().includes(query)
  )
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'add': {
      const title = taskTitle(action.title)
      if (!title || state.tasks.length >= MAX_TASKS) return state
      const task = { id: state.nextId, title, completed: false }
      return {
        ...withSelection(state, task.id),
        tasks: [task, ...state.tasks],
        nextId: state.nextId + 1,
        filter: 'all',
        query: '',
      }
    }
    case 'rename': {
      const title = taskTitle(action.title)
      if (!title || !state.tasks.some((task) => task.id === action.id && task.title !== title))
        return state
      return {
        ...state,
        tasks: state.tasks.map((task) => (task.id === action.id ? { ...task, title } : task)),
      }
    }
    case 'toggle':
      if (!state.tasks.some((task) => task.id === action.id)) return state
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === action.id ? { ...task, completed: !task.completed } : task
        ),
      }
    case 'select':
      return state.tasks.some((task) => task.id === action.id)
        ? withSelection(state, action.id)
        : state
    case 'remove': {
      const index = state.tasks.findIndex((task) => task.id === action.id)
      if (index === -1) return state
      const tasks = state.tasks.filter((task) => task.id !== action.id)
      const selectedId =
        state.selectedId === action.id
          ? (tasks[Math.min(index, tasks.length - 1)]?.id ?? null)
          : state.selectedId
      const next = withSelection(state, selectedId)
      // A deleted task's plan has no remaining owner.
      return { ...next, tasks, plan: next.plan?.taskId === action.id ? null : next.plan }
    }
    case 'filter':
      return state.filter === action.filter ? state : { ...state, filter: action.filter }
    case 'search':
      return state.query === action.query ? state : { ...state, query: action.query }
    case 'theme':
      return { ...state, theme: state.theme === 'light' ? 'dark' : 'light' }
    case 'plan-start':
      if (state.selectedId === null || state.plan?.status === 'streaming') return state
      return {
        ...state,
        plan: { id: state.nextPlanId, taskId: state.selectedId, steps: [], status: 'streaming' },
        nextPlanId: state.nextPlanId + 1,
      }
    case 'plan-step': {
      const plan = state.plan
      // A stale or late callback cannot write into a stopped or newer plan.
      if (!plan || plan.id !== action.id || plan.status !== 'streaming') return state
      const steps = [...plan.steps, PLAN_STEPS[plan.steps.length]!]
      return {
        ...state,
        plan: {
          ...plan,
          steps,
          status: steps.length === PLAN_STEPS.length ? 'complete' : 'streaming',
        },
      }
    }
    case 'plan-stop':
      return state.plan?.status === 'streaming' ? { ...state, plan: stopPlan(state.plan) } : state
  }
}
