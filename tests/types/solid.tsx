import type { JSX } from '@bun-native/solid'
import { For, Show } from 'solid-js'

export function Supported(): JSX.Element {
  return (
    <box
      style={{ direction: 'column', gap: 8, overflow: 'scroll_y', min_width: 40 }}
      onClickCapture={(event) => event.stopPropagation()}
      onInput={(event) => void event.value}
      onFocusCapture={(event) => void event.currentTarget.kind}
    >
      <text>Native text</text>
      <button
        onClick={(event) => void event.signal.aborted}
        onKeyDown={(event) => void event.keyChar}
        onKeyUpCapture={(event) => void event.modifiers.shift}
        onPointerDown={(event) => void event.x}
        onPointerUpCapture={(event) => void event.button}
        onBlur={(event) => void event.path}
      >
        Increment
      </button>
      <input value="initial" onInput={(event) => void event.revision} />
      <input value={{ value: 'revision-aware', revision: 0 }} />
      <For each={[1, 2]}>{(value) => <text text={String(value)} />}</For>
      <Show when={true}>
        <text text="Shown" />
      </Show>
    </box>
  )
}

// @ts-expect-error HTML/DOM tags are not native elements.
export const BrowserTag = <div />
// @ts-expect-error Native buttons require typed click callbacks.
export const BadHandler = <button onClick="run()" />
// @ts-expect-error Native styles are explicit numeric/shared contracts, not CSS text.
export const BrowserStyle = <box style="display:flex" />
// @ts-expect-error No browser event or generic HTML prop escapes the boundary.
export const BrowserProp = <input onChange={() => {}} />

// @ts-expect-error Controlled input state must carry its native revision.
export const UnversionedObject = <input value={{ value: 'replacement' }} />

// @ts-expect-error Leaf controls may clip but only boxes own native scrolling.
export const ScrollingInput = <input style={{ overflow: 'scroll_y' }} />
// @ts-expect-error Pointer metadata does not fabricate a keyboard key.
export const WrongEventField = <button onPointerDown={(event) => event.key} />
// @ts-expect-error The pre-keymap logical-key API cannot observe physical key codes.
export const PhysicalCode = <input onKeyDown={(event) => event.code} />
// @ts-expect-error Repeat metadata is not available in the pinned pre-keymap interceptor.
export const RepeatedKey = <input onKeyDown={(event) => event.repeat} />
// @ts-expect-error Asynchronous callbacks cannot cancel a native action already performed.
export const NativeCancellation = <box onClickCapture={(event) => event.preventDefault()} />
