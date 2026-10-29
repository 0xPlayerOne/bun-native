/** Fixed contributor workload; increasing this is not a retry or deadline fallback. */
export const WINDOW_COMMAND_WORKLOAD_MS = 25_000

/** The last popup is disposed while open, so its public listeners are already fenced. */
export const windowCommandFixtureEvents = [
  { type: 'command', sequence: 1, command: 'record', source: 'shortcut' },
  { type: 'menu-shown', sequence: 2 },
  { type: 'command', sequence: 3, command: 'record', source: 'menu' },
  { type: 'menu-closed', sequence: 4 },
  { type: 'menu-shown', sequence: 5 },
  { type: 'menu-closed', sequence: 6 },
  { type: 'menu-shown', sequence: 7 },
] as const
