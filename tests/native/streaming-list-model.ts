import type { Style } from '@bun-native/core'
import {
  digest,
  historyText,
  STREAMING_LIST_FIXTURE,
  streamToken,
} from '../../benchmarks/streaming-list-fixture.ts'

/**
 * App-level windowing over the shared renderer (#257).
 *
 * Only the visible window of a long, append-only history becomes native nodes.
 * The scroll position is an index anchor owned by the application, so appends
 * never move a detached view, and selection is a stable message id. Native
 * flex layout still adapts the window to OS resizes; it does not choose rows.
 */
export type Author = 'user' | 'assistant'
export interface Message {
  readonly id: number
  readonly author: Author
  readonly text: string
  readonly streaming: boolean
}
export type ThemeName = 'dark' | 'light'
export type DensityName = 'comfortable' | 'compact'

/** Semantic color tokens; values are native 24-bit RGB, not CSS strings. */
export interface ThemeTokens {
  readonly background: number
  readonly surface: number
  readonly selected: number
  readonly text: number
  readonly muted: number
  readonly accent: number
}
/** Logical-pixel spacing/type scale. GPUI applies the OS scale factor on top. */
export interface DensityTokens {
  readonly rows: number
  readonly rowHeight: number
  readonly rowPadding: number
  readonly gap: number
  readonly fontSize: number
  readonly metaSize: number
}
export const THEMES: Readonly<Record<ThemeName, ThemeTokens>> = Object.freeze({
  dark: Object.freeze({
    background: 0x101820,
    surface: 0x1b2633,
    selected: 0x2f4a6d,
    text: 0xeaf0f8,
    muted: 0x9fb0c4,
    accent: 0x5fa8ff,
  }),
  light: Object.freeze({
    background: 0xf4f6f8,
    surface: 0xffffff,
    selected: 0xd6e6ff,
    text: 0x17212b,
    muted: 0x506070,
    accent: 0x1f5fbf,
  }),
})
export const DENSITIES: Readonly<Record<DensityName, DensityTokens>> = Object.freeze({
  comfortable: Object.freeze({
    rows: 9,
    rowHeight: 56,
    rowPadding: 8,
    gap: 6,
    fontSize: 15,
    metaSize: 12,
  }),
  compact: Object.freeze({
    rows: 14,
    rowHeight: 36,
    rowPadding: 3,
    gap: 2,
    fontSize: 12,
    metaSize: 10,
  }),
})
export const MAX_ROWS = Math.max(...Object.values(DENSITIES).map((density) => density.rows))
/** Native nodes per row (box, meta text, body text) and per frame (see `ListFrame`). */
export const NODES_PER_ROW = 3
export const FRAME_NODES = 9
/** One pointer selection listener per visible row; the frame registers none. */
export const LISTENERS_PER_ROW = 1

export interface ListRow {
  readonly id: number
  readonly meta: string
  readonly text: string
  readonly selected: boolean
  readonly streaming: boolean
}
/** The complete framework-visible state. It is small and replaced per change. */
export interface ListView {
  readonly rows: readonly ListRow[]
  readonly anchor: number
  readonly total: number
  readonly selected: number | null
  readonly follow: boolean
  readonly theme: ThemeName
  readonly density: DensityName
  readonly status: string
}

export type NavigationKey = 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end' | 'f7' | 'f8'
export const NAVIGATION_KEYS: ReadonlySet<string> = new Set<NavigationKey>([
  'up',
  'down',
  'pageup',
  'pagedown',
  'home',
  'end',
  'f7',
  'f8',
])

export class StreamingList {
  private readonly messages: Message[] = []
  private anchor = 0
  private selectedId: number | null = null
  private follow = true
  private theme: ThemeName = 'dark'
  private density: DensityName = 'comfortable'
  private ticks = 0

  constructor(history: number = STREAMING_LIST_FIXTURE.historyMessages) {
    for (let index = 0; index < history; index++)
      this.messages.push({
        id: index + 1,
        author: index % 2 === 0 ? 'user' : 'assistant',
        text: historyText(index),
        streaming: false,
      })
    this.tail()
    this.selectedId = this.messages.at(-1)?.id ?? null
  }

  get total(): number {
    return this.messages.length
  }
  get tick(): number {
    return this.ticks
  }
  get following(): boolean {
    return this.follow
  }

  private get rows(): number {
    return DENSITIES[this.density].rows
  }
  private tail(): void {
    this.anchor = Math.max(0, this.messages.length - this.rows)
  }
  private clamp(): void {
    this.anchor = Math.min(Math.max(0, this.anchor), Math.max(0, this.messages.length - this.rows))
  }
  private indexOf(id: number | null): number {
    // Ids are dense and 1-based in this append-only history.
    return id === null ? -1 : id - 1
  }
  private reveal(index: number): void {
    if (index < this.anchor) this.anchor = index
    else if (index >= this.anchor + this.rows) this.anchor = index - this.rows + 1
    this.clamp()
  }

  /** Appends one deterministic token. A detached view keeps its anchor and selection. */
  stream(): boolean {
    if (this.ticks >= STREAMING_LIST_FIXTURE.ticks) return false
    const tick = this.ticks++
    let open = this.messages.at(-1)
    if (!open?.streaming) {
      open = { id: this.messages.length + 1, author: 'assistant', text: '', streaming: true }
      this.messages.push(open)
    }
    const done = (tick + 1) % STREAMING_LIST_FIXTURE.tokensPerMessage === 0
    this.messages[this.messages.length - 1] = {
      ...open,
      text: open.text + streamToken(tick),
      streaming: !done && this.ticks < STREAMING_LIST_FIXTURE.ticks,
    }
    if (this.follow) {
      this.tail()
      this.selectedId = this.messages.at(-1)!.id
    }
    return true
  }

  /** Returns false for keys outside the list's navigation contract. */
  key(key: string): boolean {
    if (!NAVIGATION_KEYS.has(key)) return false
    const last = this.messages.length - 1
    const current = Math.max(0, this.indexOf(this.selectedId))
    const move = (index: number) => {
      // An empty history has nothing to select; keep the anchor in range.
      if (last < 0) return this.clamp()
      const next = Math.min(Math.max(0, index), last)
      this.selectedId = this.messages[next]!.id
      this.follow = false
      this.reveal(next)
    }
    switch (key as NavigationKey) {
      case 'up':
        move(current - 1)
        break
      case 'down':
        move(current + 1)
        break
      case 'pageup':
        this.anchor -= this.rows
        move(current - this.rows)
        break
      case 'pagedown':
        this.anchor += this.rows
        move(current + this.rows)
        break
      case 'home':
        move(0)
        break
      case 'end':
        this.follow = true
        this.tail()
        this.selectedId = this.messages[last]?.id ?? null
        break
      case 'f7':
        this.theme = this.theme === 'dark' ? 'light' : 'dark'
        break
      case 'f8':
        this.density = this.density === 'comfortable' ? 'compact' : 'comfortable'
        if (this.follow) this.tail()
        else this.reveal(Math.max(0, this.indexOf(this.selectedId)))
        break
    }
    return true
  }

  /** Pointer selection of a visible row detaches the view from the tail. */
  select(id: number): boolean {
    const index = this.indexOf(id)
    if (index < this.anchor || index >= this.anchor + this.rows || index >= this.total) return false
    this.selectedId = id
    this.follow = false
    return true
  }

  view(): ListView {
    const rows: ListRow[] = []
    const end = Math.min(this.messages.length, this.anchor + this.rows)
    for (let index = this.anchor; index < end; index++) {
      const message = this.messages[index]!
      rows.push({
        id: message.id,
        meta: `#${message.id} · ${message.author}${message.streaming ? ' · streaming' : ''}`,
        text: message.text,
        selected: message.id === this.selectedId,
        streaming: message.streaming,
      })
    }
    return Object.freeze({
      rows: Object.freeze(rows),
      anchor: this.anchor,
      total: this.messages.length,
      selected: this.selectedId,
      follow: this.follow,
      theme: this.theme,
      density: this.density,
      status:
        `${this.messages.length} messages · rows ${this.anchor + 1}–${end}` +
        ` · ${this.follow ? 'following' : 'detached'} · tick ${this.ticks}`,
    })
  }

  digest(): string {
    return digest(this.messages.map((message) => `${message.id}:${message.text}`))
  }
}

/** Native text accepts only visible/hidden overflow. */
export type TextStyle = Omit<Style, 'overflow'> & { overflow?: 'visible' | 'hidden' }
/** The token selection a row's styles depend on. */
export type Tokens = Pick<ListView, 'theme' | 'density'>

/** Framework-independent styles: Solid and React render the same native tree. */
export function frameStyle(view: ListView): Style {
  return {
    direction: 'row',
    width: 'fill',
    height: 'fill',
    padding: 12,
    gap: 12,
    background: THEMES[view.theme].background,
  }
}
export function sidebarStyle(view: ListView): Style {
  return {
    direction: 'column',
    gap: 8,
    padding: 10,
    width: 220,
    min_width: 140,
    flex_shrink: 1,
    height: 'fill',
    background: THEMES[view.theme].surface,
  }
}
export function sidebarTextStyle(view: Tokens, muted = false): TextStyle {
  const theme = THEMES[view.theme]
  return { color: muted ? theme.muted : theme.text, font_size: DENSITIES[view.density].metaSize }
}
export function mainStyle(): Style {
  return { direction: 'column', gap: 8, width: 0, flex_grow: 1, min_width: 240, height: 'fill' }
}
export function headerStyle(view: ListView): TextStyle {
  return { height: 24, flex_shrink: 0, color: THEMES[view.theme].text, font_size: 14 }
}
export function listStyle(view: ListView): Style {
  return {
    direction: 'column',
    gap: DENSITIES[view.density].gap,
    height: 0,
    flex_grow: 1,
    min_height: 0,
    overflow: 'hidden',
    // A following view keeps the newest row visible when the OS shrinks the window.
    justify_content: view.follow ? 'end' : 'start',
  }
}
/**
 * `accessibility_lists_v1`: the list reports the whole history as its set
 * size although only `rows` items are mounted, and each mounted item its
 * 1-based place in that history and whether it is the selection.
 */
export function listAccessibility(view: ListView) {
  return {
    accessibleRole: 'list',
    accessibleLabel: 'Messages',
    accessibleSetSize: view.total,
  } as const
}
export function rowAccessibility(row: ListRow) {
  return {
    accessibleRole: 'list_item',
    accessiblePosition: row.id,
    accessibleSelected: row.selected,
  } as const
}
export function rowStyle(view: Tokens, row: ListRow): Style {
  const theme = THEMES[view.theme]
  const density = DENSITIES[view.density]
  return {
    direction: 'column',
    gap: 2,
    padding: density.rowPadding,
    height: density.rowHeight,
    width: 'fill',
    flex_shrink: 0,
    overflow: 'hidden',
    background: row.selected ? theme.selected : theme.surface,
  }
}
export function metaStyle(view: Tokens, row: ListRow): TextStyle {
  const theme = THEMES[view.theme]
  return {
    font_size: DENSITIES[view.density].metaSize,
    color: row.streaming ? theme.accent : theme.muted,
  }
}
export function bodyStyle(view: Tokens): TextStyle {
  return { font_size: DENSITIES[view.density].fontSize, color: THEMES[view.theme].text }
}
export const sidebarLines = (view: ListView): readonly [string, string, string] => [
  `Theme: ${view.theme} (F7)`,
  `Density: ${view.density} (F8)`,
  view.selected === null ? 'No selection' : `Selected #${view.selected}`,
]
