import type { ErrorInfo } from 'react'

/** Owned callbacks must be revocable even while React retains an opaque root. */
export interface RootErrorOwner {
  terminate: ((error: unknown) => void) | undefined
  report: ((error: unknown, info: Readonly<ErrorInfo>) => void) | undefined
}

/** Created outside the Root constructor so callback scopes cannot capture its arguments. */
export function createRootErrors(owner: RootErrorOwner) {
  return {
    uncaught(error: unknown): void {
      owner.terminate?.(error)
    },
    /**
     * An error a boundary handled is logged like React DOM's default instead
     * of disappearing; it does not end the root.
     */
    caught(error: unknown): void {
      if (owner.terminate) console.error(error)
    },
    /** React's default transition indicator: native views show none. */
    transitionIndicator(): void {},
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
