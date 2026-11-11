/**
 * Shared state, themes and in-process window for the adapter workspace
 * benchmarks. Both adapters render the same tree from the same state.
 */
import type { NativeBatch, NativeNode, NativeWindow } from '@bun-native/core'

export type Operations = {
  create: number
  set: number
  insert: number
  remove: number
}
export type Message = {
  id: number
  subject: string
  preview: string
  date: string
  starred: boolean
}
export type Workspace = {
  folders: { id: number; name: string; unread: number }[]
  messages: Message[]
  selected: number
  theme: number
  query: string
  log: string
}

export const themes = [
  {
    background: 0xffffff,
    text: 0x202020,
    muted: 0x707070,
    selection: 0xd0e4ff,
  },
  {
    background: 0x1e1e1e,
    text: 0xe0e0e0,
    muted: 0x909090,
    selection: 0x264f78,
  },
]

const logLine = (index: number) =>
  'INFO  12:00:' + String(index % 60).padStart(2, '0') + ' request completed in 3 ms\n'

export const now = () => Number(process.hrtime.bigint()) / 1e3
export const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1]!

/**
 * An in-process window counting native operations, the initial state, and
 * the measured state changes. Each change keeps the tree the same size.
 */
export function fakeWindow(rows: number) {
  const operations: Operations = { create: 0, set: 0, insert: 0, remove: 0 }
  let id = 0
  const handle = (kind: string) => ({ kind, id: id++ }) as unknown as NativeNode
  const batch: NativeBatch = {
    create: (element) => {
      operations.create += 1
      return handle(element.kind) as never
    },
    set: () => {
      operations.set += 1
    },
    insert: () => {
      operations.insert += 1
    },
    append: () => {
      operations.insert += 1
    },
    focus: () => {},
    scrollTo: () => {},
    scrollIntoView: () => {},
    remove: () => {
      operations.remove += 1
    },
  }
  const window = {
    root: handle('box'),
    closed: new Promise<void>(() => {}),
    revision: 0,
    batch: async (update: (batch: NativeBatch) => unknown) => update(batch),
    on: () => () => {},
    input: () => ({ value: '', revision: 0 }),
    close: async () => {},
  } as unknown as NativeWindow
  let lines = 0
  let log = ''
  // A ~12,000 character log pane: about 250 lines.
  while (log.length < 12_000) log += logLine(lines++)
  let current: Workspace = {
    folders: Array.from({ length: 12 }, (_, index) => ({
      id: index,
      name: 'Folder ' + index,
      unread: index * 3,
    })),
    messages: Array.from({ length: rows }, (_, index) => ({
      id: index,
      subject: (index % 2 ? 'Invoice ' : 'Meeting notes ') + index,
      preview: 'Preview text for message ' + index + ' with a few more words',
      date: 'Nov ' + ((index % 28) + 1),
      starred: index % 5 === 0,
    })),
    selected: 0,
    theme: 0,
    query: '',
    log,
  }
  let step = 0
  const update: Record<string, () => void> = {
    // Selection moves: two rows change background.
    select: () => (current = { ...current, selected: (current.selected + 7) % rows }),
    // One row's star toggles: one button text.
    star: () => {
      const index = (step++ * 7919) % rows
      const messages = current.messages.slice()
      messages[index] = {
        ...messages[index]!,
        starred: !messages[index]!.starred,
      }
      current = { ...current, messages }
    },
    // The log pane appends a line and drops the first: one large text set.
    log: () => {
      const text = current.log
      current = {
        ...current,
        log: text.slice(text.indexOf('\n') + 1) + logLine(lines++),
      }
    },
    // Theme switch: every styled node changes.
    theme: () => (current = { ...current, theme: (current.theme + 1) % themes.length }),
    // Search filters half the rows, then clears: alternate remove/insert of half.
    filter: () => (current = { ...current, query: current.query ? '' : 'Invoice' }),
  }
  return { window, operations, state: () => current, update }
}
