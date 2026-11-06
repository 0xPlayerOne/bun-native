import type { InputState } from '@bun-native/core'
import { inputState, type JSX, type SolidNode } from '@bun-native/solid'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import {
  MAX_CONVERSATIONS,
  MAX_MESSAGES,
  MAX_PROMPT_LENGTH,
  selectedConversation,
  WorkspaceController,
  type ReplyScheduler,
  type WorkspaceOwnership,
  type WorkspaceState,
} from './model.ts'

const palettes = {
  dark: {
    background: 0x151b24,
    panel: 0x222d3c,
    text: 0xeaf0f8,
    muted: 0xb3c0d2,
    accent: 0x344e74,
  },
  light: {
    background: 0xf3f5f8,
    panel: 0xffffff,
    text: 0x182230,
    muted: 0x526174,
    accent: 0xdce9ff,
  },
}
type Palette = (typeof palettes)['dark']

function ConversationPane(props: {
  id: number
  state: () => WorkspaceState
  palette: () => Palette
  controller: WorkspaceController
}): JSX.Element {
  // A conversation switch creates a new input owner with revision zero; its
  // stored draft is separate from the previous input's native edit authority.
  const initial = selectedConversation(props.state())
  if (initial.id !== props.id) throw new Error('Conversation owner must match the selected session')
  const conversation = () =>
    props.state().conversations.find((item) => item.id === initial.id) ?? initial
  const [draft, setDraft] = createSignal<InputState>({ value: initial.draft, revision: 0 })
  let composer: SolidNode | undefined
  const streaming = () => conversation().messages.some((message) => message.status === 'streaming')
  const canSend = () =>
    !streaming() &&
    draft().value.trim().length > 0 &&
    draft().value.trim().length <= MAX_PROMPT_LENGTH &&
    conversation().messages.length <= MAX_MESSAGES - 2

  function send() {
    if (!composer) return
    const observed = inputState(composer)
    if (props.controller.send(observed.value)) setDraft({ value: '', revision: observed.revision })
  }

  return (
    <box style={{ direction: 'column', width: 0, flex_grow: 1, min_width: 260, gap: 12 }}>
      <box style={{ direction: 'row', align_items: 'center', gap: 8, height: 40, flex_shrink: 0 }}>
        <text style={{ color: props.palette().text, font_size: 22, flex_grow: 1 }}>
          {conversation().title}
        </text>
        <button
          text="Clear history"
          style={{
            width: 112,
            height: 36,
            color: props.palette().text,
            background: props.palette().panel,
          }}
          onClick={() => props.controller.requestClear()}
        />
        <button
          text="Close conversation"
          disabled={props.state().conversations.length === 1}
          style={{
            width: 156,
            height: 36,
            color: props.palette().text,
            background: props.palette().panel,
          }}
          onClick={() => props.controller.close()}
        />
      </box>
      <Show when={props.state().clearConfirmation === initial.id}>
        <box
          style={{
            direction: 'column',
            gap: 8,
            padding: 12,
            background: props.palette().accent,
            flex_shrink: 0,
          }}
        >
          <text style={{ color: props.palette().text }}>Clear this conversation's history?</text>
          <text style={{ color: props.palette().muted }}>
            In-app confirmation · This also cancels an unfinished reply.
          </text>
          <box style={{ direction: 'row', gap: 8, height: 36 }}>
            <button
              text="Confirm clear"
              style={{ width: 140, color: props.palette().text, background: props.palette().panel }}
              onClick={() => props.controller.confirmClear()}
            />
            <button
              text="Keep history"
              style={{ width: 140, color: props.palette().text, background: props.palette().panel }}
              onClick={() => props.controller.dismissClear()}
            />
          </box>
        </box>
      </Show>
      <box
        style={{
          direction: 'column',
          gap: 10,
          padding: 12,
          height: 0,
          flex_grow: 1,
          min_height: 0,
          overflow: 'scroll_y',
          background: props.palette().panel,
        }}
      >
        <Show when={conversation().messages.length === 0}>
          <text style={{ color: props.palette().muted }}>
            No messages yet. Write a prompt below.
          </text>
        </Show>
        <For each={conversation().messages.map((message) => message.id)}>
          {(id) => {
            const message = () => conversation().messages.find((item) => item.id === id)
            return (
              <box
                style={{
                  direction: 'column',
                  gap: 6,
                  padding: 12,
                  min_height: 92,
                  flex_shrink: 0,
                  background: props.palette().background,
                }}
              >
                <text style={{ color: props.palette().muted, font_size: 13 }}>
                  {message()?.role === 'user' ? 'You' : 'Local assistant'} · {id}
                </text>
                <text style={{ color: props.palette().text, width: 'fill' }}>
                  {message()?.body || 'Waiting for local text…'}
                </text>
                <text style={{ color: props.palette().muted, font_size: 12 }}>
                  {message()?.status === 'streaming'
                    ? 'Streaming locally'
                    : message()?.status === 'cancelled'
                      ? 'Cancelled'
                      : 'Complete'}
                </text>
              </box>
            )
          }}
        </For>
      </box>
      <box style={{ direction: 'column', gap: 8, flex_shrink: 0 }}>
        <text style={{ color: props.palette().muted }}>
          {streaming() ? 'Local reply in progress' : 'Local simulation · No backend connected'}
        </text>
        <input
          ref={(node) => {
            composer = node
          }}
          value={draft()}
          placeholder="Write a local prompt"
          style={{
            height: 42,
            width: 'fill',
            color: props.palette().text,
            background: props.palette().panel,
          }}
          onInput={(event) => {
            setDraft(event)
            props.controller.setDraft(event.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'enter') send()
          }}
        />
        <box style={{ direction: 'row', gap: 8, height: 38 }}>
          <button
            text="Send prompt"
            disabled={!canSend()}
            style={{
              width: 140,
              color: canSend() ? props.palette().text : props.palette().muted,
              background: props.palette().accent,
            }}
            onClick={send}
          />
          <button
            text="Cancel reply"
            disabled={!streaming()}
            style={{
              width: 140,
              color: streaming() ? props.palette().text : props.palette().muted,
              background: props.palette().panel,
            }}
            onClick={() => props.controller.cancel()}
          />
        </box>
        <text style={{ color: props.palette().muted, font_size: 12 }}>
          {conversation().messages.length >= MAX_MESSAGES
            ? 'History limit reached. Clear history to continue.'
            : `Enter sends · Up to ${MAX_PROMPT_LENGTH} characters · ${MAX_MESSAGES} messages per conversation`}
        </text>
      </box>
    </box>
  )
}

/** Shared unchanged by the interactive example and native qualification entry. */
export function Workspace(
  props: {
    onChange?: (state: WorkspaceState) => void
    onDispose?: (state: WorkspaceState, ownership: WorkspaceOwnership) => void
    /** Qualification only: a fixture-owned reply clock. The example uses real timers. */
    schedule?: ReplyScheduler
    /** Qualification only: drive the same component's actions without OS input. */
    onController?: (controller: WorkspaceController) => void
  } = {}
): JSX.Element {
  const controller = new WorkspaceController((next) => setState(next), props.schedule)
  props.onController?.(controller)
  const [state, setState] = createSignal(controller.state)
  const palette = () => palettes[state().theme]
  createEffect(() => props.onChange?.(state()))
  onCleanup(() => {
    controller.dispose()
    props.onDispose?.(controller.state, controller.ownership)
  })

  return (
    <box
      style={{
        direction: 'column',
        width: 'fill',
        height: 'fill',
        padding: 16,
        gap: 12,
        background: palette().background,
      }}
    >
      <box style={{ direction: 'row', align_items: 'center', gap: 12, height: 44, flex_shrink: 0 }}>
        <text style={{ color: palette().text, font_size: 26, flex_grow: 1 }}>
          Adea inspired workspace
        </text>
        <button
          text={state().theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
          style={{ width: 148, height: 38, color: palette().text, background: palette().panel }}
          onClick={() => controller.toggleTheme()}
        />
        <button
          text={state().details ? 'Hide details' : 'Show details'}
          style={{ width: 120, height: 38, color: palette().text, background: palette().panel }}
          onClick={() => controller.toggleDetails()}
        />
      </box>
      <text style={{ color: palette().muted, height: 24, flex_shrink: 0 }}>
        Solid native reference · Local demo data · Changes last for this session
      </text>
      <box style={{ direction: 'row', gap: 12, height: 0, flex_grow: 1, min_height: 0 }}>
        <box style={{ direction: 'column', width: 188, flex_shrink: 0, gap: 10 }}>
          <text style={{ color: palette().text, font_size: 18, height: 28, flex_shrink: 0 }}>
            Conversations
          </text>
          <button
            text="New conversation"
            disabled={state().conversations.length >= MAX_CONVERSATIONS}
            style={{
              height: 38,
              flex_shrink: 0,
              color: palette().text,
              background: palette().accent,
            }}
            onClick={() => controller.create()}
          />
          <box
            style={{
              direction: 'column',
              gap: 8,
              height: 0,
              flex_grow: 1,
              min_height: 0,
              overflow: 'scroll_y',
            }}
          >
            <For each={state().conversations.map((conversation) => conversation.id)}>
              {(id) => (
                <button
                  text={
                    state().conversations.find((conversation) => conversation.id === id)?.title ??
                    ''
                  }
                  style={{
                    height: 44,
                    flex_shrink: 0,
                    color: palette().text,
                    background: state().selectedId === id ? palette().accent : palette().panel,
                  }}
                  onClick={() => controller.select(id)}
                />
              )}
            </For>
          </box>
          <text style={{ color: palette().muted, font_size: 12, height: 20, flex_shrink: 0 }}>
            {state().conversations.length} / {MAX_CONVERSATIONS} conversations
          </text>
        </box>
        <Show when={state().selectedId} keyed>
          {(id: number) => (
            <ConversationPane id={id} state={state} palette={palette} controller={controller} />
          )}
        </Show>
        <Show when={state().details}>
          <box
            style={{
              direction: 'column',
              width: 212,
              flex_shrink: 0,
              padding: 14,
              gap: 12,
              overflow: 'scroll_y',
              background: palette().panel,
            }}
          >
            <text style={{ color: palette().text, font_size: 18 }}>Workspace details</text>
            <text style={{ color: palette().muted }}>
              Replies stream from a local deterministic source. Cancel or switch conversations to
              stop pending work.
            </text>
            <text style={{ color: palette().text, font_size: 18 }}>Terminal / PTY</text>
            <text style={{ color: palette().muted }}>
              Unsupported in this reference app. No shell process is running.
            </text>
            <text style={{ color: palette().text, font_size: 18 }}>Try the native UI</text>
            <text style={{ color: palette().muted }}>
              Click the composer to focus, press Enter to send, scroll history, resize the window,
              and hide this pane for more space.
            </text>
            <text style={{ color: palette().muted }}>
              The clear-history panel is an in-app confirmation, not an OS dialog.
            </text>
          </box>
        </Show>
      </box>
    </box>
  )
}
