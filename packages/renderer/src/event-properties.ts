import type { Listener, NativeEventMap, NativeEventType, NativeUIEvent } from '@bun-native/core'

function binding<T extends NativeEventType>(type: T, capture = false) {
  return Object.freeze({ type, capture })
}

/** Both adapters use the public core's event types and propagation phases. */
export const eventProperties = Object.freeze({
  onClick: binding('click'),
  onClickCapture: binding('click', true),
  onInput: binding('input'),
  onInputCapture: binding('input', true),
  onKeyDown: binding('key_down'),
  onKeyDownCapture: binding('key_down', true),
  onKeyUp: binding('key_up'),
  onKeyUpCapture: binding('key_up', true),
  onPointerDown: binding('pointer_down'),
  onPointerDownCapture: binding('pointer_down', true),
  onPointerUp: binding('pointer_up'),
  onPointerUpCapture: binding('pointer_up', true),
  onFocus: binding('focus'),
  onFocusCapture: binding('focus', true),
  onBlur: binding('blur'),
  onBlurCapture: binding('blur', true),
})

export type EventProperty = keyof typeof eventProperties
export type EventHandlers = {
  [Property in EventProperty]?: Listener<NativeEventMap[(typeof eventProperties)[Property]['type']]>
}

export function isEventProperty(name: string): name is EventProperty {
  return Object.hasOwn(eventProperties, name)
}

// The string-based universal renderer accepts unknown property values. After
// checking the property name and callable value, store one erased signature;
// the descriptor selects the matching core event, while JSX keeps its narrow type.
export type EventListener = Listener<NativeUIEvent>
export type EventListeners = Partial<Record<EventProperty, EventListener>>
const emptyListeners: Readonly<EventListeners> = Object.freeze({})

export function listeners(properties: EventListeners): Readonly<EventListeners> {
  let result: EventListeners | undefined
  for (const name of Object.keys(properties)) {
    if (!isEventProperty(name)) continue
    const listener = properties[name]
    if (listener) (result ??= {})[name] = listener
  }
  return result ? Object.freeze(result) : emptyListeners
}
