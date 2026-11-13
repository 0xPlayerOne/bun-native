/**
 * Compile-only parity between the generated wire schema and the protocol's
 * TypeScript unions: every command, event, operation and element kind has
 * exactly the members the schema lists, and no union has a tag it lacks.
 */
import type { Command, Element, KeyModifiers, NativeEvent, Operation } from '@bun-native/protocol'
import type {
  COMMAND_KEYS,
  ELEMENT_KEYS,
  EVENT_KEYS,
  MODIFIER_KEYS,
  OPERATION_KEYS,
} from '../../packages/protocol/src/wire-schema.ts'

/** Every member name of every variant, optional ones included. */
type Keys<T> = T extends unknown ? keyof T : never
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Members<S> = S extends ReadonlySet<infer K> ? K : never
/** `true` per tag whose variants have exactly the schema's members; `false` names a drift. */
type Parity<Union, Tag extends string, Table> = {
  [K in keyof Table]: Same<Keys<Extract<Union, Record<Tag, K>>>, Members<Table[K]>>
}
type Agrees<P> = { [K in keyof P]: true }

declare const commands: Parity<Command, 'type', typeof COMMAND_KEYS>
declare const events: Parity<NativeEvent, 'type', typeof EVENT_KEYS>
declare const operations: Parity<Operation, 'type', typeof OPERATION_KEYS>
declare const elements: Parity<Element, 'kind', typeof ELEMENT_KEYS>

export const commandMembers: Agrees<typeof commands> = commands
export const eventMembers: Agrees<typeof events> = events
export const operationMembers: Agrees<typeof operations> = operations
export const elementMembers: Agrees<typeof elements> = elements

export const commandTags: Same<Command['type'], keyof typeof COMMAND_KEYS> = true
export const eventTags: Same<NativeEvent['type'], keyof typeof EVENT_KEYS> = true
export const operationTags: Same<Operation['type'], keyof typeof OPERATION_KEYS> = true
export const elementTags: Same<Element['kind'], keyof typeof ELEMENT_KEYS> = true
export const modifierMembers: Same<keyof KeyModifiers, Members<typeof MODIFIER_KEYS>> = true
