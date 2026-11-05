import type { ErrorInfo } from 'react'

/** Owned callbacks must be revocable even while React retains an opaque root. */
export interface RootErrorOwner {
  terminate: ((error: unknown) => void) | undefined
  report: ((error: unknown, info: Readonly<ErrorInfo>) => void) | undefined
}

function ignore(): void {}

/** Created outside the Root constructor so callback scopes cannot capture its arguments. */
export function createRootErrors(owner: RootErrorOwner) {
  return {
    uncaught(error: unknown): void {
      owner.terminate?.(error)
    },
    caught: ignore,
    transition: ignore,
    recoverable(error: unknown, info: ErrorInfo): void {
      const report = owner.report
      if (!report) return
      try {
        report(error, Object.freeze({ ...info }))
      } catch (reporterError) {
        owner.terminate?.(reporterError)
      }
    },
    release(): void {
      owner.terminate = undefined
      owner.report = undefined
    },
  }
}
