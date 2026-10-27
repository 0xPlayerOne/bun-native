/** Private, bounded trusted-generation channel. Names and sequence IDs are not authority. */
export interface ServiceCallContext {
  readonly signal: AbortSignal
}
export type ServiceHandler = (
  input: string,
  context: ServiceCallContext
) => string | Promise<string>
export interface ServiceGenerationContext {
  readonly state: string | undefined
  readonly signal: AbortSignal
  invoke(resource: string, operation: string, input: string): Promise<string>
  /** Reserve cleanup before installing a generation-owned timer or subscription. */
  own(cleanup: () => void | Promise<void>): () => Promise<void>
  /** Duplicate registration is rejected before publication. */
  handle(name: string, handler: ServiceHandler): void
}
export interface ServiceDefinition {
  readonly schema: string
  readonly state?: string
  readonly handlers?: Readonly<Record<string, ServiceHandler>>
  readonly dispose?: () => void | Promise<void>
}
export type ServiceApplication = (
  context: ServiceGenerationContext
) => ServiceDefinition | Promise<ServiceDefinition>
export interface ServiceChannelLimits {
  readonly payloadBytes: number
  readonly messageBytes: number
  readonly requests: number
  readonly handlers: number
  readonly cleanup: number
}
export const SERVICE_CHANNEL_DEFAULTS: ServiceChannelLimits = Object.freeze({
  payloadBytes: 65536,
  messageBytes: 524288,
  requests: 64,
  handlers: 128,
  cleanup: 256,
})
export function serviceLabel(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
}
export function serviceInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}
export function serviceJson(value: unknown, maximum: number): value is string {
  if (typeof value !== 'string' || value.length > maximum || Buffer.byteLength(value) > maximum)
    return false
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}
export function serviceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function decodeServiceMessage(value: unknown, maximum: number): Record<string, unknown> {
  if (typeof value !== 'string' || value.length > maximum || Buffer.byteLength(value) > maximum)
    throw new Error('Invalid generation message size or type')
  const parsed: unknown = JSON.parse(value)
  if (!serviceRecord(parsed) || !serviceLabel(parsed['type']))
    throw new Error('Invalid generation message')
  return parsed
}
export function encodeServiceMessage(value: Record<string, unknown>, maximum: number): string {
  const result = JSON.stringify(value)
  if (result.length > maximum || Buffer.byteLength(result) > maximum)
    throw new Error('Generation message exceeds configured capacity')
  return result
}
/** Source-mapped stacks are private developer diagnostics, never published evidence payloads. */
export function serviceErrorDetail(error: unknown): string {
  try {
    return (error instanceof Error ? (error.stack ?? error.message) : 'Application rejected').slice(
      0,
      8192
    )
  } catch {
    return 'Application rejected'
  }
}
