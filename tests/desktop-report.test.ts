import { expect, test } from 'bun:test';
import { desktopEditStages } from '../benchmarks/lib/desktop-report.ts';
import { DESKTOP_EDIT_STEPS, type DesktopEditResult } from '../benchmarks/lib/desktop-edits.ts';
import { STAGES } from '../benchmarks/lib/stages.ts';
// These test inputs are synthetic records, not desktop observations.
function fixture(): DesktopEditResult {
  return { passed: true, kind: 'desktop', artifactKind: 'application-directory', cleanupFailures: [], steps: DESKTOP_EDIT_STEPS.map(name => ({
    name, status: 'passed', elapsedMs: 15, observations: [], reason: 'unit test record', timings: {},
  })) };
}
test('desktop reporting maps only operations actually executed by this workload', () => {
  const rows = desktopEditStages(fixture(), null);
  expect(rows).toHaveLength(STAGES.length);
  expect(rows.filter(row => row.status === 'passed').map(row => row.stage)).toEqual(['backend-edit', 'app-assembly']);
  expect(rows.filter(row => row.status === 'unsupported').every(row => row.elapsedMs === null)).toBe(true);
  expect(rows.find(row => row.stage === 'warm-dev-launch')?.status).toBe('unsupported');
  expect(rows.find(row => row.stage === 'first-run')?.status).toBe('unsupported');
});
test('unexecuted stages and setup failures do not become zero-cost successes', () => {
  expect(desktopEditStages(null, 'runtime missing').every(row => row.status === 'unsupported' && row.elapsedMs === null)).toBe(true);
  const input = fixture();
  const result = desktopEditStages({ ...input, steps: input.steps.map(row => row.name === 'backend-edit' ? { ...row, status: 'not-executed', elapsedMs: null } : row) }, null);
  expect(result.find(row => row.stage === 'backend-edit')?.elapsedMs).toBeNull();
});
test('harness-only reports cannot supply desktop measurement evidence', () => {
  expect(desktopEditStages({ ...fixture(), kind: 'harness-test' }, null).every(row => row.status === 'unsupported')).toBe(true);
});
test('late cleanup failure invalidates otherwise successful desktop measurements', () => {
  const rows = desktopEditStages({ ...fixture(), cleanupFailures: ['unreaped descendant'], passed: false }, null);
  expect(rows.filter(row => row.status === 'passed')).toHaveLength(0);
  expect(rows.filter(row => row.status === 'failed')).toHaveLength(2);
});
test('missing or duplicated executed steps fail schema mapping', () => {
  const f = fixture();
  expect(() => desktopEditStages({ ...f, steps: [] }, null)).toThrow();
  expect(() => desktopEditStages({ ...f, steps: [...f.steps, f.steps[0]!] }, null)).toThrow();
});

test('compiling an Electron main bundle is not full application assembly', () => {
  const rows = desktopEditStages({ ...fixture(), artifactKind: 'main-bundle' }, null);
  expect(rows.find(row => row.stage === 'app-assembly')?.status).toBe('unsupported');
  expect(rows.find(row => row.stage === 'backend-edit')?.status).toBe('passed');
});
