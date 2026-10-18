/** Ordered execution records for trusted benchmark adapters, never a script service. */
export const STAGES = ['cold-install', 'warm-dev-launch', 'frontend-edit', 'backend-edit', 'app-assembly', 'release-sign', 'installer-compress', 'first-run', 'update'] as const;
export type StageName = typeof STAGES[number];
export interface StageRecord {
  readonly stage: StageName;
  readonly status: 'passed' | 'failed' | 'unsupported';
  readonly elapsedMs: number | null;
  readonly reason: string;
  readonly validation: { readonly passed: boolean; readonly evidence: string };
}
export interface StageClock { now(): number; set(ms: number, callback: () => void): unknown; clear(timer: unknown): void }
const defaultClock: StageClock = {
  now: () => performance.now(), set: (ms, callback) => setTimeout(callback, ms),
  clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
export function validateStage(input: unknown): StageRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid stage record');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 5 || Object.keys(value).some(key => !['stage', 'status', 'elapsedMs', 'reason', 'validation'].includes(key)) ||
      !STAGES.includes(value['stage'] as StageName) || !['passed', 'failed', 'unsupported'].includes(String(value['status']))) throw new Error('Invalid stage identity');
  for (const field of ['reason']) if (typeof value[field] !== 'string' || !value[field].length || value[field].length > 4096) throw new Error('Missing stage reason');
  const check = value['validation'];
  if (!check || typeof check !== 'object' || Array.isArray(check)) throw new Error('Missing stage validation');
  const validation = check as Record<string, unknown>;
  if (Object.keys(validation).length !== 2 || typeof validation['passed'] !== 'boolean' || typeof validation['evidence'] !== 'string' ||
      !validation['evidence'].length || validation['evidence'].length > 4096) throw new Error('Invalid stage evidence');
  if (value['status'] === 'unsupported') {
    if (value['elapsedMs'] !== null || validation['passed']) throw new Error('Unsupported stage cannot have successful timing');
  } else if (typeof value['elapsedMs'] !== 'number' || !Number.isFinite(value['elapsedMs']) || value['elapsedMs'] < 0) throw new Error('Invalid stage timing');
  if ((value['status'] === 'passed') !== validation['passed']) throw new Error('Stage result contradicts validation');
  return Object.freeze({ ...value, validation: Object.freeze({ ...validation }) }) as unknown as StageRecord;
}
export function unsupportedStage(stage: StageName, reason: string): StageRecord {
  return validateStage({ stage, status: 'unsupported', elapsedMs: null, reason, validation: { passed: false, evidence: reason } });
}
export function validateStageMatrix(records: readonly StageRecord[]): readonly StageRecord[] {
  if (records.length !== STAGES.length) throw new Error('Incomplete stage matrix');
  const parsed = records.map(validateStage);
  if (new Set(parsed.map(row => row.stage)).size !== STAGES.length) throw new Error('Duplicate stage');
  return Object.freeze(parsed);
}
export interface StageExecution { readonly evidence: string; readonly valid: boolean }
/** Includes execution AND output validation. Adapters retain diagnostic timing on failure. */
export async function measureStage(stage: StageName, execute: (signal: AbortSignal) => Promise<StageExecution>, options: {
  readonly timeoutMs?: number; readonly clock?: StageClock; readonly signal?: AbortSignal;
} = {}): Promise<StageRecord> {
  if (!STAGES.includes(stage)) throw new Error('Unknown stage');
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000) throw new Error('Invalid stage deadline');
  const clock = options.clock ?? defaultClock, start = clock.now();
  const controller = new AbortController(); let timer: unknown;
  let rejectAbort!: (reason: Error) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const stop = () => { controller.abort(); rejectAbort(new Error('Stage cancelled or deadline exceeded')); };
  try {
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    timer = clock.set(timeout, stop);
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted(); return execute(controller.signal);
    });
    const output = await Promise.race([work, cancelled]);
    const elapsedMs = clock.now() - start;
    if (elapsedMs >= timeout || controller.signal.aborted) throw new Error('Stage deadline exceeded during validation');
    return validateStage({ stage, status: output.valid ? 'passed' : 'failed', elapsedMs,
      reason: output.valid ? 'Executed and validated output' : 'Executed output failed validation',
      validation: { passed: output.valid, evidence: output.evidence } });
  } catch (error) {
    controller.abort();
    return validateStage({ stage, status: 'failed', elapsedMs: clock.now() - start,
      reason: error instanceof Error ? error.message.slice(0, 4096) || 'Stage failed' : 'Stage failed',
      validation: { passed: false, evidence: 'No successful output validation; caller must reap any uncooperative child work before starting another trial' } });
  } finally { clock.clear(timer); options.signal?.removeEventListener('abort', stop); }
}
