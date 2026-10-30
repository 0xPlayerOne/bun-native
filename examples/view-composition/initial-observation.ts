import { defineRpc, procedure } from '../../packages/contracts/src/rpc.ts'
import { compositionSchema, panes, type Pane } from './contract.ts'

export const INITIAL_OBSERVATION_LIMIT = 32
export const initialObservationPhases = [
  'initial',
  'before-create',
  'after-create',
  'before-show',
] as const
export type InitialObservationPhase = (typeof initialObservationPhases)[number]
export type InitialObservationCommand = Exclude<InitialObservationPhase, 'initial'> | 'stop'
export interface InitialObservationEvent {
  readonly event: InitialObservationPhase | 'visibilitychange' | 'focus' | 'blur'
  readonly visibility: 'visible' | 'hidden'
  readonly focused: boolean
  /** Checkpoints sample actual state; only browser events have an isTrusted value. */
  readonly trusted: boolean | null
}
export interface InitialObservation {
  readonly pane: Pane
  readonly instance: string
  readonly phase: InitialObservationPhase
  readonly events: readonly InitialObservationEvent[]
  readonly overflow: boolean
}
export interface InitialObservationCollector {
  readonly instance: string
  snapshot(phase: InitialObservationPhase): InitialObservation
  stop(): void
}

function invalid(): never {
  throw new Error('Invalid initial composition observation')
}
function fields(value: unknown, names: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== names) invalid()
  return row
}
export function parseInitialObservation(value: unknown): InitialObservation {
  const row = fields(value, 'events,instance,overflow,pane,phase')
  if (
    !panes.includes(row['pane'] as Pane) ||
    typeof row['instance'] !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(row['instance']) ||
    !initialObservationPhases.includes(row['phase'] as InitialObservationPhase) ||
    typeof row['overflow'] !== 'boolean' ||
    !Array.isArray(row['events']) ||
    row['events'].length === 0 ||
    row['events'].length > INITIAL_OBSERVATION_LIMIT
  )
    invalid()
  const events = Array.from(row['events'], (value): InitialObservationEvent => {
    const event = fields(value, 'event,focused,trusted,visibility')
    const checkpoint = initialObservationPhases.includes(event['event'] as InitialObservationPhase)
    if (
      typeof event['event'] !== 'string' ||
      (!checkpoint && !['visibilitychange', 'focus', 'blur'].includes(event['event'])) ||
      (event['visibility'] !== 'visible' && event['visibility'] !== 'hidden') ||
      typeof event['focused'] !== 'boolean' ||
      (checkpoint ? event['trusted'] !== null : event['trusted'] !== true)
    )
      invalid()
    return Object.freeze({ ...event }) as unknown as InitialObservationEvent
  })
  const phases = initialObservationPhases.filter(
    (phase) => row['pane'] !== 'overlay' || phase !== 'before-create'
  )
  const phase = phases.indexOf(row['phase'] as InitialObservationPhase)
  if (
    phase < 0 ||
    events[0]!.event !== 'initial' ||
    events
      .filter((event) => initialObservationPhases.includes(event.event as InitialObservationPhase))
      .map((event) => event.event)
      .join(',') !== phases.slice(0, phase + 1).join(',') ||
    (phase !== 0 && events.at(-1)!.event !== row['phase'])
  )
    invalid()
  return Object.freeze({
    pane: row['pane'] as Pane,
    instance: row['instance'],
    phase: row['phase'] as InitialObservationPhase,
    events: Object.freeze(events),
    overflow: row['overflow'],
  })
}

/** A completed, authenticated history. Never converts requested intent to observation. */
export function requireInitialObservation(value: unknown): InitialObservation {
  const history = parseInitialObservation(value)
  if (history.overflow || history.phase !== 'before-show') invalid()
  if (history.pane === 'overlay') {
    if (
      history.events.some(
        (event) =>
          event.visibility !== 'hidden' ||
          event.focused ||
          event.event === 'focus' ||
          event.event === 'blur'
      )
    )
      throw new Error('Hidden overlay was exposed or received focus before its first show')
  } else {
    const start = history.events.findIndex((event) => event.event === 'before-create')
    const end = history.events.findIndex((event) => event.event === 'after-create')
    const focused = history.pane === 'right'
    if (
      history.events
        .slice(start, end + 1)
        .some(
          (event) =>
            event.visibility !== 'visible' ||
            event.focused !== focused ||
            event.event === (focused ? 'blur' : 'focus')
        )
    )
      throw new Error('Hidden overlay creation disturbed the existing pane focus owner')
  }
  return history
}

export const interactionSchema = defineRpc({
  ...compositionSchema,
  initialObservation: procedure(
    parseInitialObservation,
    (value: unknown): { next: InitialObservationCommand } => {
      const row = fields(value, 'next')
      if (
        typeof row['next'] !== 'string' ||
        !['before-create', 'after-create', 'before-show', 'stop'].includes(row['next'])
      )
        invalid()
      return { next: row['next'] as InitialObservationCommand }
    }
  ),
})
