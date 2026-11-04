export const MAX_TASKS = 200
export const MAX_TITLE_LENGTH = 120

export interface Task {
  readonly id: number
  readonly title: string
  readonly completed: boolean
}

export type TaskFilter = 'all' | 'active' | 'completed'
export type Theme = 'light' | 'dark'

export interface WorkspaceState {
  readonly tasks: readonly Task[]
  readonly selectedId: number | null
  readonly filter: TaskFilter
  readonly query: string
  readonly theme: Theme
  readonly nextId: number
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
  }
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
        ...state,
        tasks: [task, ...state.tasks],
        selectedId: task.id,
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
      return state.selectedId === action.id || !state.tasks.some((task) => task.id === action.id)
        ? state
        : { ...state, selectedId: action.id }
    case 'remove': {
      const index = state.tasks.findIndex((task) => task.id === action.id)
      if (index === -1) return state
      const tasks = state.tasks.filter((task) => task.id !== action.id)
      const selectedId =
        state.selectedId === action.id
          ? (tasks[Math.min(index, tasks.length - 1)]?.id ?? null)
          : state.selectedId
      return { ...state, tasks, selectedId }
    }
    case 'filter':
      return state.filter === action.filter ? state : { ...state, filter: action.filter }
    case 'search':
      return state.query === action.query ? state : { ...state, query: action.query }
    case 'theme':
      return { ...state, theme: state.theme === 'light' ? 'dark' : 'light' }
  }
}
