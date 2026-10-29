import { expect, test } from 'bun:test'
import type { TerminalClosure, TerminalProcessExit } from '../packages/runtime/src/index.ts'

const processFailureLabels: Record<NonNullable<TerminalProcessExit['failure']>, string> = {
  SPAWN_FAILED: 'spawn failed',
  DEADLINE_EXCEEDED: 'deadline expired',
  TERMINATION_DENIED: 'termination denied',
  SUPERVISION_FAILED: 'supervision failed',
  SCHEDULER_FAILED: 'lifecycle deadline unavailable',
}
const closureFailureLabels: Record<NonNullable<TerminalClosure['failure']>, string> = {
  SPAWN_FAILED: 'spawn failed',
  DEADLINE_EXCEEDED: 'deadline expired',
  SCHEDULER_FAILED: 'lifecycle deadline unavailable',
}

// Existing exhaustive maps fail to typecheck until the new case is added.
// @ts-expect-error SCHEDULER_FAILED is required by the expanded public union.
const oldClosureLabels: Record<NonNullable<TerminalClosure['failure']>, string> = {
  SPAWN_FAILED: 'spawn failed',
  DEADLINE_EXCEEDED: 'deadline expired',
}
void oldClosureLabels

test('exhaustive terminal failure consumers handle scheduler failure distinctly', () => {
  expect(processFailureLabels.SCHEDULER_FAILED).toBe('lifecycle deadline unavailable')
  expect(closureFailureLabels.SCHEDULER_FAILED).toBe('lifecycle deadline unavailable')
})
