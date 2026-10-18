import { expect, test } from 'bun:test';
import { STAGES, measureStage, unsupportedStage, validateStage, validateStageMatrix, type StageClock } from '../benchmarks/lib/stages.ts';
test('stage records require actual validation, not a command exit alone', async () => {
  const good = await measureStage('app-assembly', async () => ({ valid: true, evidence: 'Bundle executed' }));
  expect(good.status).toBe('passed'); expect(good.elapsedMs).toBeGreaterThanOrEqual(0);
  const bad = await measureStage('app-assembly', async () => ({ valid: false, evidence: 'Bundle output incorrect' }));
  expect(bad.status).toBe('failed');
});
test('unsupported stages have null timings and cannot count as success', () => {
  expect(unsupportedStage('release-sign', 'No signing identity')).toMatchObject({ status: 'unsupported', elapsedMs: null });
  expect(() => validateStage({ ...unsupportedStage('release-sign', 'No identity'), elapsedMs: 0 })).toThrow('Unsupported');
});
test('stage matrix cannot omit signing or update work', () => {
  const all = STAGES.map(stage => unsupportedStage(stage, 'Not executed'));
  expect(validateStageMatrix(all)).toHaveLength(STAGES.length);
  expect(() => validateStageMatrix(all.slice(1))).toThrow('Incomplete');
  all[1] = all[0]!; expect(() => validateStageMatrix(all)).toThrow('Duplicate');
});
test('deadline cancels a cooperative action and returns a failed timing', async () => {
  let signal: AbortSignal | undefined;
  const row = await measureStage('cold-install', async value => { signal = value; return await new Promise(() => {}); }, { timeoutMs: 10 });
  expect(row.status).toBe('failed'); expect(signal?.aborted).toBe(true); expect(row.reason).toContain('deadline');
});
test('pre-aborted stages never start the action', async () => {
  const controller = new AbortController(); controller.abort(); let ran = false;
  const row = await measureStage('first-run', async () => { ran = true; return { valid: true, evidence: 'unexpected' }; }, { signal: controller.signal });
  expect(row.status).toBe('failed'); expect(ran).toBe(false);
});
test('elapsed deadline fails even before its callback gets scheduled', async () => {
  let time = 0; const clock: StageClock = { now: () => time, set: () => 1, clear: () => {} };
  const result = await measureStage('frontend-edit', async () => { time = 11; return { valid: true, evidence: 'late' }; }, { timeoutMs: 10, clock });
  expect(result.status).toBe('failed'); expect(result.elapsedMs).toBe(11);
});
test('action errors preserve failure and settle without unhandled work', async () => {
  const result = await measureStage('update', async () => { throw new Error('Invalid update bytes'); });
  expect(result.status).toBe('failed'); expect(result.reason).toBe('Invalid update bytes');
});
test('reject invalid deadlines and malformed stage records', async () => {
  for (const timeoutMs of [0, -1, NaN, 1.5, 600001]) await expect(measureStage('update', async () => ({ valid: true, evidence: 'ok' }), { timeoutMs })).rejects.toThrow('deadline');
  const row = unsupportedStage('release-sign', 'Unavailable');
  for (const value of [{ ...row, unknown: true }, { ...row, stage: 'invented' }, { ...row, validation: { passed: true, evidence: 'bad' } }]) expect(() => validateStage(value)).toThrow();
});
