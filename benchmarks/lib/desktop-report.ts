/** Maps observed operations, not convenient substitutes, into the stage matrix. */
import { STAGES, unsupportedStage, validateStage, validateStageMatrix, type StageRecord } from './stages.ts';
import type { DesktopEditResult, DesktopStep } from './desktop-edits.ts';
export function desktopEditStages(result: DesktopEditResult | null, setupFailure: string | null): readonly StageRecord[] {
  const explanation = setupFailure ? 'Prerequisite/setup failure; this stage was not executed' :
    result?.kind !== 'desktop' ? 'No actual desktop execution; harness tests are not measurements' :
    'Not measured by the explicit stop-build-relaunch workload';
  const rows = STAGES.map(stage => unsupportedStage(stage, explanation));
  if (setupFailure || result?.kind !== 'desktop') return validateStageMatrix(rows);
  function observed(stage: 'app-assembly' | 'backend-edit', name: DesktopStep['name']): void {
    const matching = result!.steps.filter(step => step.name === name);
    if (matching.length !== 1) throw new Error('Missing or duplicate desktop step');
    const step = matching[0]!;
    if (step.status === 'not-executed') return;
    const passed = step.status === 'passed' && result!.cleanupFailures.length === 0;
    const evidence = stage === 'app-assembly'
      ? 'Initial actual framework build through exit/output checks and observer reaping. Includes instrumentation; not pure compiler time.'
      : 'Source write, prior app shutdown, rebuild, fresh backend/document revision acknowledgement, and fixture disk-state validation. Not watcher or managed HMR timing.';
    const record = validateStage({ stage, status: passed ? 'passed' : 'failed', elapsedMs: step.elapsedMs,
      reason: passed ? 'Executed and validated desktop operation' : 'Desktop step or owned-process cleanup failed',
      validation: { passed, evidence } });
    rows[rows.findIndex(row => row.stage === stage)] = record;
  }
  if (result.artifactKind === 'application-directory') observed('app-assembly', 'initial-build');
  observed('backend-edit', 'backend-edit');
  // An initial fixture launch is retained in steps, not relabeled as warmed dev
  // or an installed first run. Signing, networking and update costs stay absent.
  return validateStageMatrix(rows);
}
