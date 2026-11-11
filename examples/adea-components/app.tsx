import type { InputState } from '@bun-native/core'
import type { JSX } from '@bun-native/solid'
import { batch, createSignal, For, onCleanup, Show } from 'solid-js'
import { recordEvidence } from '../native-window/content.ts'
import { Button, Dialog, DropdownMenu, Input, type ButtonVariant } from './components.tsx'
import { ConversationView, type RowStats } from './conversation.tsx'
import { withTailPage, type TranscriptHistory } from './retained/transcript-history.ts'
import { adeaTheme, type Scheme } from './tokens.ts'
import type { OpenedMessage } from './types.ts'

const VARIANTS: readonly ButtonVariant[] = [
  'default',
  'secondary',
  'outline',
  'ghost',
  'subtle',
  'success',
  'destructive',
  'link',
]

/** Deterministic reply tokens; one per tick, so every run streams the same text. */
const REPLY = ['Native', ' rows', ' keep', ' their', ' identity', ' while', ' streaming.']

const SEED: readonly OpenedMessage[] = [
  {
    id: 'm1',
    sequence: 1,
    version: 1,
    updatedAt: 't1',
    sender: 'Andrea',
    bodyText: 'Can the composer run natively?',
  },
  {
    id: 'm2',
    sequence: 2,
    version: 1,
    updatedAt: 't2',
    sender: 'Octy',
    bodyText: 'Yes: button, input, menu and dialog are native GPUI.',
  },
]

export type AppStats = RowStats & { timers: number; ownerDisposed: boolean }

export function createAppStats(): AppStats {
  return { created: 0, disposed: 0, timers: 0, ownerDisposed: false }
}

export function App(props: { stats: AppStats; tickMs?: number }): JSX.Element {
  const [scheme, setScheme] = createSignal<Scheme>('light')
  const theme = () => adeaTheme(scheme())
  const [history, setHistory] = createSignal<TranscriptHistory>({ messages: SEED })
  const [draft, setDraft] = createSignal<InputState>({ value: '', revision: 0 })
  const [confirming, setConfirming] = createSignal(false)
  const [status, setStatus] = createSignal('Ready')
  let timer: ReturnType<typeof setTimeout> | undefined
  let sequence = SEED.length

  const stop = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
    props.stats.timers -= 1
  }
  onCleanup(() => {
    stop()
    props.stats.ownerDisposed = true
  })

  /** Publish one message copy as the newest page, the way Adea applies a tail page. */
  const publish = (message: OpenedMessage) =>
    setHistory((current) => withTailPage(current, { messages: [message] }))

  const send = () => {
    const text = draft().value.trim()
    if (!text || timer !== undefined) return
    const user = {
      id: `m${++sequence}`,
      sequence,
      version: 1,
      updatedAt: `t${sequence}`,
      sender: 'You',
      bodyText: text,
    }
    const reply = {
      id: `m${++sequence}`,
      sequence,
      version: 1,
      updatedAt: `t${sequence}`,
      sender: 'Octy',
      bodyText: '',
    }
    batch(() => {
      publish(user)
      publish(reply)
      setDraft((current) => ({ value: '', revision: current.revision }))
      setStatus('Streaming')
    })
    let tokens = 0
    const tick = () => {
      props.stats.timers -= 1
      timer = undefined
      tokens += 1
      publish({ ...reply, version: tokens + 1, bodyText: REPLY.slice(0, tokens).join('') })
      if (tokens < REPLY.length) {
        timer = setTimeout(tick, props.tickMs ?? 40)
        props.stats.timers += 1
      } else {
        setStatus('Ready')
        recordEvidence({
          type: 'reply-complete',
          rows: props.stats.created,
          disposed: props.stats.disposed,
        })
      }
    }
    timer = setTimeout(tick, props.tickMs ?? 40)
    props.stats.timers += 1
    recordEvidence({ type: 'sent', text })
  }

  const clear = () => {
    stop()
    batch(() => {
      setHistory({ messages: [] })
      setConfirming(false)
      setStatus('Deleted')
    })
    recordEvidence({ type: 'deleted', disposed: props.stats.disposed })
  }

  const colors = () => theme().tokens.colors
  return (
    <box
      style={{
        direction: 'column',
        width: 'fill',
        height: 'fill',
        background: colors().background,
      }}
    >
      <box
        style={{
          direction: 'row',
          gap: 8,
          padding: 12,
          align_items: 'center',
          border_width: 1,
          border_color: colors().border,
          background: colors().background,
        }}
      >
        <text
          text="Adea components"
          style={{ font_size: 16, font_weight: 600, color: colors().foreground, flex_grow: 1 }}
        />
        <text text={status()} style={{ font_size: 12, color: colors().mutedForeground }} />
        <DropdownMenu
          theme={theme}
          label="Conversation"
          items={[
            { label: 'Rename', disabled: true },
            { label: 'Export' },
            { label: 'Delete', destructive: true },
          ]}
          onSelect={(label) => {
            if (label === 'Delete') setConfirming(true)
            else setStatus(label)
            recordEvidence({ type: 'menu', label })
          }}
        />
        <Button
          theme={theme}
          text={scheme() === 'light' ? 'Dark theme' : 'Light theme'}
          variant="outline"
          size="sm"
          onClick={() => {
            setScheme((value) => (value === 'light' ? 'dark' : 'light'))
            recordEvidence({ type: 'theme', scheme: scheme() })
          }}
        />
      </box>
      <box style={{ direction: 'row', gap: 6, padding: 12, background: colors().background }}>
        <For each={VARIANTS}>
          {(variant) => <Button theme={theme} text={variant} variant={variant} size="sm" />}
        </For>
      </box>
      <ConversationView theme={theme} history={history} stats={props.stats} />
      <box
        style={{
          direction: 'row',
          gap: 8,
          padding: 12,
          align_items: 'center',
          background: colors().background,
        }}
      >
        <Input theme={theme} value={draft()} placeholder="Message Octy" onInput={setDraft} />
        <Button theme={theme} text="Send" disabled={status() === 'Streaming'} onClick={send} />
      </box>
      <Show when={confirming()}>
        <Dialog
          theme={theme}
          title="Delete conversation?"
          description="Messages in this conversation are removed from this window."
          onDismiss={() => {
            setConfirming(false)
            recordEvidence({ type: 'dialog-dismissed' })
          }}
          footer={
            <>
              <Button
                theme={theme}
                text="Cancel"
                variant="outline"
                onClick={() => void setConfirming(false)}
              />
              <Button theme={theme} text="Delete" variant="destructive" onClick={clear} />
            </>
          }
        />
      </Show>
    </box>
  )
}
