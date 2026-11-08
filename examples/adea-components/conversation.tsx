import type { JSX } from '@bun-native/solid'
import { For, onCleanup, type Accessor } from 'solid-js'
import { keyedRows } from './retained/keyed-rows.ts'
import { sameShownMessage, type TranscriptHistory } from './retained/transcript-history.ts'
import type { AdeaTheme } from './tokens.ts'
import type { OpenedMessage } from './types.ts'

/** Row lifetime counters, so a test can prove rows survive streaming updates. */
export type RowStats = { created: number; disposed: number }

/**
 * A streaming conversation view. The row identity policy is Adea's own,
 * retained unchanged: `keyedRows` keeps one row per message id for the
 * conversation's lifetime and `sameShownMessage` decides when a fresh copy of
 * a message actually changes what the row shows. A streamed reply is a new
 * message version on every token, so its row updates in place instead of
 * remounting. Adea's `MessageScroller` (DOM scroll measurement, row-size
 * memory and older-page prefetch) is replaced by a native `scroll_y` box with
 * `scroll_anchor: 'end'`, which keeps the tail in view while streaming and
 * releases it when the user scrolls away.
 */
export function ConversationView(props: {
  theme: Accessor<AdeaTheme>
  history: Accessor<TranscriptHistory>
  stats: RowStats
}): JSX.Element {
  const rows = keyedRows(
    () => props.history().messages,
    (message: OpenedMessage) => message.id,
    sameShownMessage
  )
  const colors = () => props.theme().tokens.colors
  return (
    <box
      style={{
        direction: 'column',
        gap: 8,
        padding: 12,
        width: 'fill',
        height: 0,
        flex_grow: 1,
        min_height: 0,
        overflow: 'scroll_y',
        scroll_anchor: 'end',
        background: colors().background,
      }}
    >
      <For each={rows()}>
        {(row) => {
          props.stats.created += 1
          onCleanup(() => props.stats.disposed++)
          return (
            <box
              style={{
                direction: 'column',
                gap: 2,
                padding: 8,
                background: colors().card,
                corner_radius: props.theme().tokens.radii.md,
              }}
            >
              <text
                text={row.item().sender}
                style={{ font_size: 12, font_weight: 600, color: colors().mutedForeground }}
              />
              <text
                text={row.item().bodyText ?? ''}
                style={{ font_size: 14, color: colors().foreground }}
              />
            </box>
          )
        }}
      </For>
    </box>
  )
}
