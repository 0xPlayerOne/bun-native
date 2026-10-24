/** Destructive offline maintenance, never a renderer permission or live-session operation. */
export interface PersistentSessionResetOptions {
  /** Exact executable from a trusted, already-installed runtime. No download or compilation. */
  readonly hostExecutable: string
  readonly persistentRoot: string
  readonly partition: string
  readonly confirmation: 'delete-entire-profile'
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface PersistentSessionResetResult {
  readonly schema: 1
  readonly partition: string
  readonly offline: true
  readonly storageCleared: true
  readonly cookiesCleared: true
  readonly cacheCleared: true
  readonly recoveredInterruption: boolean
  /** Remaining profile inventory, including framework markers; not prior-attempt totals. */
  readonly remainingEntriesRemoved: number
  readonly remainingLogicalBytesRemoved: number
}
