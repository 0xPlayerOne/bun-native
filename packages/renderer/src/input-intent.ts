import { NativeStateError, type InputEvent, type NativeNode } from '@bun-native/core'

export type InputIntent = Readonly<{
  value: string
  revision: number
  observedNode: NativeNode<'input'> | undefined
}>

// Only an actual dispatched native event is an observation. A copied InputState
// is an explicit replacement intent, whose expected revision must be preserved.
const observations = new WeakMap<object, InputIntent>()

export function observeInput(event: InputEvent): void {
  observations.set(event, {
    value: event.value,
    revision: event.revision,
    observedNode: event.node,
  })
}

export function captureInput(value: unknown): string | InputIntent | undefined {
  if (value === undefined || typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(
      'Native input value must be an initial string or { value, revision } intent'
    )
  const observed = observations.get(value)
  if (observed) return Object.freeze({ ...observed })
  if (Object.keys(value).some((field) => field !== 'value' && field !== 'revision'))
    throw new TypeError('Explicit input intents accept only value and revision')
  const data = value as { value?: unknown; revision?: unknown }
  const text = data.value
  const revision = data.revision
  if (typeof text !== 'string') throw new TypeError('Input intent value must be a string')
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
    throw new NativeStateError(
      'stale_revision',
      'Input intent requires a nonnegative safe revision'
    )
  return Object.freeze({ value: text, revision, observedNode: undefined })
}
