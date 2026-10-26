/** Explicit contributor workload selection. Browser-safe and not application authority. */
const selected = (
  globalThis as typeof globalThis & {
    __bunlyTerminalLoadProfile?: unknown
  }
).__bunlyTerminalLoadProfile
if (selected !== undefined && selected !== 'standard' && selected !== 'soak')
  throw new Error('Unknown fixed terminal load profile')
export const LOAD_PROFILE = selected === 'soak' ? 'soak' : 'standard'
export const LOAD_DEFINES = Object.freeze({
  'globalThis.__bunlyTerminalLoadProfile': JSON.stringify(LOAD_PROFILE),
})
// Only the finite workload's total observer allowance changes for its 120-second
// sustained phase. Existing RPC/write/readiness/native shutdown deadlines do not.
export const LOAD_OBSERVER_MS = LOAD_PROFILE === 'soak' ? 180_000 : 90_000
export const LOAD_RAW_LIMIT = LOAD_PROFILE === 'soak' ? 16 * 1024 * 1024 : 4 * 1024 * 1024
