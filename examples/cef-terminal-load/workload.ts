import { LOAD_PROFILE } from './profile.ts'

/** Identical finite workload for every maintained load adapter. No renderer work is omitted. */
export const LOAD = Object.freeze({
  id:
    LOAD_PROFILE === 'soak'
      ? 'graphical-pty-soak-v2'
      : LOAD_PROFILE === 'windowed'
        ? 'graphical-pty-window-load-v3'
        : 'graphical-pty-load-v1',
  terminals: 2,
  recordsPerBatch: 32,
  phases: [
    { name: 'warmup', batches: 20, intervalMs: 100 },
    { name: 'ramp', batches: 40, intervalMs: 50 },
    { name: 'sustained', batches: LOAD_PROFILE === 'soak' ? 2400 : 600, intervalMs: 50 },
    { name: 'recovery', batches: 40, intervalMs: 100 },
  ],
  maxBatchBytes: 32 * 1024,
  maxCallbacksPerBatch: 256,
  modes:
    LOAD_PROFILE === 'windowed'
      ? (['foreground', 'background', 'hidden', 'minimized'] as const)
      : (['visible', 'hidden'] as const),
} as const)
export const BATCHES = LOAD.phases.reduce((sum, phase) => sum + phase.batches, 0)
export function loadBatch(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= BATCHES)
    throw new Error('Invalid load batch')
  return Number(value)
}
export function loadRecord(batch: number, index: number) {
  return { type: 'record', index, text: `fixed-${index}-café-🐙`, batch }
}
