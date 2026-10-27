import type { RendererReceipt } from './contract.ts'

/** Fixed native qualification plan. These bounds are chosen before execution. */
export const MANAGED_PLAN = Object.freeze({
  replacements: 500,
  checkpointEvery: 25,
  heapAllowanceBytes: 32 * 1024 * 1024,
  rssAllowanceBytes: 256 * 1024 * 1024,
  failureCases: [
    'syntax',
    'import',
    'initialization',
    'closed-resource',
    'runtime-handler',
  ] as const,
  frontendAfter: 125,
  sharedAt: 250,
  pendingAt: 375,
  deadlineMs: 165_000,
})
export type ManagedFailureCase = (typeof MANAGED_PLAN.failureCases)[number]
export interface ManagedRow {
  readonly schema: 1
  readonly kind:
    | 'replacement'
    | 'checkpoint'
    | 'failure'
    | 'frontend'
    | 'retirement'
    | 'restart'
    | 'renderer'
  readonly index: number
  readonly revision: number
  readonly elapsedMs: number
  readonly passed: boolean
  readonly action?: string
  readonly case?: ManagedFailureCase
  readonly servingRevision?: number
  readonly shared?: number
  readonly renderer?: RendererReceipt
  readonly editToRendererMs?: number
  readonly editKind?: 'backend' | 'shared' | 'frontend'
  readonly snapshot?: {
    readonly heapUsed: number
    readonly rss: number
    readonly external: number
    readonly owner: Record<string, unknown>
    readonly broker: Record<string, unknown>
    readonly desktop: Record<string, unknown>
    readonly terminal: Record<string, unknown>
    readonly development: Record<string, unknown>
    readonly accepted: number
    readonly settled: number
  }
}
export interface ManagedIdentities {
  readonly window: string
  readonly view: string
  readonly session: string
  readonly terminal: string
  readonly document: string
  readonly url: string
}
export interface ManagedFrontendSource {
  readonly version: number
  readonly frontend: number
  readonly shared: number
  readonly css: string
  readonly sha256: string
}
/** Public fixture evidence contains bounded first-line summaries, never local stacks. */
export interface ManagedDiagnosticText {
  readonly text: string
  readonly redacted: boolean
  readonly truncated: boolean
}
export interface ManagedFailureDiagnostic {
  readonly source: 'development' | 'broker' | 'bindings' | 'reload' | 'fixture'
  readonly event: 'error' | 'failure' | 'forced-termination'
  readonly stage: string
  readonly code?: string
  readonly generation?: number
  readonly sequence?: number
  readonly restartRequired?: boolean
  readonly candidateRetired?: boolean
  readonly committed?: boolean
  readonly message?: ManagedDiagnosticText
  readonly detail?: ManagedDiagnosticText
}
export interface ManagedFailureDiagnostics {
  readonly schema: 1
  readonly entries: readonly ManagedFailureDiagnostic[]
  readonly dropped: number
}
export interface ManagedResult {
  readonly event: 'bunly.managed-development'
  readonly schema: 1
  readonly passed: boolean
  readonly successfulReplacements: number
  readonly rendererChecks: number
  readonly failures: Readonly<Partial<Record<ManagedFailureCase, boolean>>>
  readonly frontend: {
    readonly notifications: number
    readonly acknowledged: number
    readonly sharedEdits: number
    readonly externalHmr: false
    readonly sources: readonly ManagedFrontendSource[]
  }
  readonly retirement: {
    readonly accepted: number
    readonly settled: number
    readonly outcome: string
    readonly staleMutations: number
  }
  readonly identities: {
    readonly before: ManagedIdentities | null
    readonly after: ManagedIdentities | null
    readonly stable: boolean
  }
  readonly terminal: {
    readonly launches: number
    readonly runtimeBytes: number
    readonly rendererBytes: number
    readonly runtimeHash: string
    readonly rendererHash: string
    readonly records: number
    readonly lastSequence: number
    readonly acks: number
    readonly released: boolean
    readonly outputOk: boolean
    readonly processExit: {
      readonly started: boolean
      readonly exitCode: number | null
      readonly signalCode: string | null
      readonly waitError: boolean
    } | null
    readonly terminalClose: { readonly status: number } | null
  }
  readonly requests: {
    readonly accepted: number
    readonly settled: number
    readonly pending: number
  }
  readonly final: {
    readonly owner: Record<string, unknown>
    readonly broker: Record<string, unknown>
    readonly desktop: Record<string, unknown>
    readonly terminal: Record<string, unknown>
    readonly development: Record<string, unknown>
    readonly native: Record<string, unknown>
    readonly nativeSnapshotPhase: 'before-last-window-close'
  }
  readonly restartRequired: boolean
  readonly failureCode?: string
  readonly diagnostics?: ManagedFailureDiagnostics
}
