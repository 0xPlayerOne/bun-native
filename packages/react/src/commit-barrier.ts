/** Revocable ownership for a callback retained by an opaque reconciler update. */
export interface CommitBarrierBindings {
  release: (() => void) | undefined
  resolve: (() => void) | undefined
  reject: ((cause: unknown) => void) | undefined
}

function settle(bindings: CommitBarrierBindings, failed: boolean, cause?: unknown): void {
  const release = bindings.release
  const resolve = bindings.resolve
  const reject = bindings.reject
  // Revoke the actual root/promise bindings before callbacks can reenter.
  bindings.release = undefined
  bindings.resolve = undefined
  bindings.reject = undefined
  release?.()
  if (failed) reject?.(cause)
  else resolve?.()
}

/** Keep this factory outside Root's scope; retained callbacks own only this cell. */
export function createCommitBarrier(bindings: CommitBarrierBindings) {
  return {
    complete(): void {
      settle(bindings, false)
    },
    reject(cause: unknown): void {
      settle(bindings, true, cause)
    },
  }
}
