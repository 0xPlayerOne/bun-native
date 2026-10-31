// Compile-only public surface fixture. This function is never invoked.
import type { NativeNode, NativeWindow } from '@bun-native/core'

void function eventTypes(window: NativeWindow, button: NativeNode<'button'>) {
  window.on(
    window.root,
    'key_down',
    (event) => {
      const text: string | undefined = event.keyChar
      const control: boolean = event.modifiers.control
      void [text, control]
      // @ts-expect-error Physical key codes are not part of the current native contract.
      void event.code
      // @ts-expect-error Native asynchronous default-action cancellation is not supported.
      event.preventDefault()
    },
    { capture: true }
  )
  window.on(button, 'pointer_down', (event) => {
    const x: number = event.x
    void x
    // @ts-expect-error A pointer event is not a text edit.
    void event.value
  })
  window.on(window.root, 'input', (event) => {
    const target: NativeNode<'input'> = event.node
    const current: NativeNode = event.currentTarget
    void [target, current]
    // @ts-expect-error Input revisions cannot be mutated by observers.
    event.revision = 3
  })
  // @ts-expect-error Scrolling events are not exposed by this increment.
  window.on(window.root, 'wheel', () => {})
}
