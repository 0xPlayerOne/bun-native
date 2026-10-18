import { summarize } from './statistics.ts';
export type Unit = 'ms' | 'bytes' | 'count' | 'percent';
export interface Metric { value: number; unit: Unit }
export interface Trial {
  variant: string; scenario: string; trial: number; warmup: boolean;
  status: 'passed' | 'failed' | 'unsupported'; reason: string;
  correctness: { passed: boolean; details: string };
  metrics: Record<string, Metric>;
}
export interface Variant {
  id: string; framework: string; version: string; sourceCommit: string | null;
  runtime: string; runtimeVersion: string; engine: string; engineVersion: string | null;
  securityProfile: string; configuration: 'default' | 'tuned';
}
export interface BenchmarkRun {
  schema: 1; createdAt: string; fixtureSha256: string; seed: number; repetitions: number; warmups: number;
  scenarios: string[]; variants: Variant[]; parameters: Record<string, number | string | boolean>;
  environment: { runClass: 'controlled' | 'ci-smoke' | 'local-smoke'; target: string; os: string; cpu: string;
    logicalCpus: number; memoryBytes: number; gpu: string; display: string; power: string; machineLabel: string };
  sourceCommit: string; trials: Trial[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}
function text(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.length || value.length > 4096) throw new Error('Expected bounded non-empty string'); }
function count(value: unknown, minimum = 0): asserts value is number { if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > 100000) throw new Error('Invalid count'); }
export function validateRun(input: unknown): BenchmarkRun {
  const run = object(input);
  if (run['schema'] !== 1) throw new Error('Unsupported result schema');
  text(run['createdAt']); if (!Number.isFinite(Date.parse(run['createdAt']))) throw new Error('Invalid timestamp');
  text(run['sourceCommit']); text(run['fixtureSha256']);
  if (!/^[a-f0-9]{64}$/.test(run['fixtureSha256'])) throw new Error('Missing fixture digest');
  count(run['seed']); count(run['repetitions'], 1); count(run['warmups']);
  if (!Array.isArray(run['scenarios']) || !run['scenarios'].length) throw new Error('Missing scenarios');
  for (const scenario of run['scenarios']) text(scenario);
  const scenarios = run['scenarios'] as string[];
  if (new Set(scenarios).size !== scenarios.length) throw new Error('Duplicate scenario');
  const environment = object(run['environment']);
  if (!['controlled', 'ci-smoke', 'local-smoke'].includes(String(environment['runClass']))) throw new Error('Unknown run class');
  for (const key of ['target', 'os', 'cpu', 'gpu', 'display', 'power', 'machineLabel']) text(environment[key]);
  count(environment['logicalCpus'], 1);
  if (!Number.isSafeInteger(environment['memoryBytes']) || Number(environment['memoryBytes']) <= 0) throw new Error('Invalid RAM accounting');
  const parameters = object(run['parameters']);
  for (const value of Object.values(parameters)) if (!['string', 'boolean', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid workload parameter');
  if (!Array.isArray(run['variants']) || !run['variants'].length) throw new Error('Missing variants');
  const ids = new Set<string>();
  for (const entry of run['variants']) {
    const variant = object(entry);
    for (const key of ['id', 'framework', 'version', 'runtime', 'runtimeVersion', 'engine', 'securityProfile']) text(variant[key]);
    if (ids.has(variant['id'] as string)) throw new Error('Duplicate variant'); ids.add(variant['id'] as string);
    if (variant['sourceCommit'] !== null && !/^[a-f0-9]{40}$/.test(String(variant['sourceCommit']))) throw new Error('Unpinned source commit');
    if (variant['engineVersion'] !== null) text(variant['engineVersion']);
    if (!['default', 'tuned'].includes(String(variant['configuration']))) throw new Error('Unknown configuration');
  }
  if (!Array.isArray(run['trials']) || run['trials'].length > 100000) throw new Error('Missing or excessive trials');
  const seen = new Set<string>();
  for (const entry of run['trials']) {
    const trial = object(entry);
    text(trial['variant']); text(trial['scenario']); text(trial['reason']); count(trial['trial']);
    if (!ids.has(trial['variant']) || !scenarios.includes(trial['scenario'])) throw new Error('Undeclared scenario or variant');
    if (typeof trial['warmup'] !== 'boolean' || Number(trial['trial']) >= Number(trial['warmup'] ? run['warmups'] : run['repetitions'])) throw new Error('Trial outside plan');
    const key = `${trial['variant']}|${trial['scenario']}|${trial['warmup']}|${trial['trial']}`;
    if (seen.has(key)) throw new Error('Duplicate trial'); seen.add(key);
    if (!['passed', 'failed', 'unsupported'].includes(String(trial['status']))) throw new Error('Invalid trial status');
    const correctness = object(trial['correctness']); text(correctness['details']);
    if (typeof correctness['passed'] !== 'boolean') throw new Error('Missing correctness result');
    if (trial['status'] === 'passed' && !correctness['passed']) throw new Error('Cannot pass incorrect workload');
    const metrics = object(trial['metrics']);
    if (trial['status'] === 'unsupported' && Object.keys(metrics).length) throw new Error('Unsupported work cannot report performance');
    for (const item of Object.values(metrics)) {
      const metric = object(item);
      if (!['ms', 'bytes', 'count', 'percent'].includes(String(metric['unit'])) || typeof metric['value'] !== 'number' || !Number.isFinite(metric['value']) || metric['value'] < 0) throw new Error('Invalid metric');
    }
    if (trial['status'] === 'passed' && !Object.keys(metrics).length) throw new Error('Passed measurement has no metrics');
  }
  const expected = ids.size * scenarios.length * (Number(run['repetitions']) + Number(run['warmups']));
  if (seen.size !== expected) throw new Error(`Incomplete result matrix: ${seen.size}/${expected}`);
  return input as BenchmarkRun;
}
function unknown(value: string | null): boolean { return value === null || /unknown|unverified/i.test(value); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function browserKnown(variant: Variant): boolean {
  return variant.engine === 'none' ? variant.engineVersion === null : !unknown(variant.engineVersion);
}
function pinnedSource(run: BenchmarkRun): boolean { return /^[a-f0-9]{40}$/.test(run.sourceCommit); }
function metadataReady(run: BenchmarkRun, variant: Variant): boolean {
  const env = run.environment;
  return env.runClass === 'controlled' && pinnedSource(run) && browserKnown(variant) &&
    ![env.target, env.os, env.machineLabel, env.cpu, env.gpu, env.power, env.display, variant.runtimeVersion, variant.securityProfile].some(unknown);
}
export function reportRun(input: unknown) {
  const run = validateRun(input);
  return run.variants.flatMap(variant => run.scenarios.map(scenario => {
    const all = run.trials.filter(trial => trial.variant === variant.id && trial.scenario === scenario);
    const trials = all.filter(trial => !trial.warmup);
    const warmups = all.filter(trial => trial.warmup);
    const passed = trials.filter(trial => trial.status === 'passed');
    const metrics: Record<string, ReturnType<typeof summarize> & { unit: Unit }> = {};
    for (const name of new Set(passed.flatMap(trial => Object.keys(trial.metrics)))) {
      const entries = passed.map(trial => trial.metrics[name]);
      if (entries.some(entry => !entry) || new Set(entries.map(entry => entry!.unit)).size !== 1) throw new Error('Metric coverage/unit mismatch');
      metrics[name] = { ...summarize(entries.map(entry => entry!.value), run.seed), unit: entries[0]!.unit };
    }
    return { variant: variant.id, scenario, passed: passed.length, failed: trials.filter(trial => trial.status === 'failed').length,
      unsupported: trials.filter(trial => trial.status === 'unsupported').length,
      warmups: { passed: warmups.filter(trial => trial.status === 'passed').length,
        failed: warmups.filter(trial => trial.status === 'failed').length,
        unsupported: warmups.filter(trial => trial.status === 'unsupported').length }, metrics,
      eligibleForPerformanceClaim: metadataReady(run, variant) && all.every(trial => trial.status === 'passed') };
  }));
}
export function compareRuns(beforeInput: unknown, afterInput: unknown, beforeId: string, afterId: string) {
  const before = validateRun(beforeInput); const after = validateRun(afterInput);
  const a = before.variants.find(variant => variant.id === beforeId); const b = after.variants.find(variant => variant.id === afterId);
  const reasons: string[] = [];
  if (!a || !b) throw new Error('Unknown comparison variant');
  if (before.fixtureSha256 !== after.fixtureSha256 || canonical(before.parameters) !== canonical(after.parameters)) reasons.push('Different fixture/workload');
  if (canonical(before.environment) !== canonical(after.environment)) reasons.push('Different environments');
  if (before.environment.runClass !== 'controlled' || after.environment.runClass !== 'controlled') reasons.push('Smoke/CI timings are not controlled performance evidence');
  if ([before.environment, after.environment].some(env => [env.target, env.os, env.machineLabel, env.cpu, env.gpu, env.power, env.display].some(unknown))) reasons.push('Incomplete environment metadata');
  if (!pinnedSource(before) || !pinnedSource(after)) reasons.push('Unpinned benchmark source');
  if (unknown(a.runtimeVersion) || unknown(b.runtimeVersion)) reasons.push('Unverified runtime identity');
  if (!browserKnown(a) || !browserKnown(b) || a.engine !== b.engine || a.engineVersion !== b.engineVersion) reasons.push('Different or unverified browser engines');
  if (a.securityProfile !== b.securityProfile || unknown(a.securityProfile) || unknown(b.securityProfile)) reasons.push('Different or unverified security');
  if (JSON.stringify(before.scenarios) !== JSON.stringify(after.scenarios)) reasons.push('Different scenario plans');
  if (before.trials.some(trial => trial.variant === beforeId && trial.warmup && trial.status !== 'passed') ||
      after.trials.some(trial => trial.variant === afterId && trial.warmup && trial.status !== 'passed')) reasons.push('Failed or unsupported warmup coverage');
  const left = reportRun(before).filter(row => row.variant === beforeId);
  const right = reportRun(after).filter(row => row.variant === afterId);
  if ([...left, ...right].some(row => row.failed || row.unsupported)) reasons.push('Incomplete successful workload coverage');
  for (const row of left) {
    const other = right.find(candidate => candidate.scenario === row.scenario);
    if (!other || canonical(Object.keys(row.metrics).sort()) !== canonical(Object.keys(other.metrics).sort()) ||
        Object.entries(row.metrics).some(([name, stats]) => other.metrics[name]?.unit !== stats.unit)) {
      reasons.push('Different metric coverage or units'); break;
    }
  }
  if (reasons.length) return { comparable: false, reasons, changes: [] };
  const changes = left.flatMap(row => Object.entries(row.metrics).map(([metric, stats]) => {
    const next = right.find(other => other.scenario === row.scenario)?.metrics[metric];
    if (!next || next.unit !== stats.unit) throw new Error('Missing comparable metric');
    return { scenario: row.scenario, metric, unit: stats.unit, before: stats.mean, after: next.mean,
      changePercent: stats.mean === 0 ? null : (next.mean / stats.mean - 1) * 100 };
  }));
  return { comparable: true, reasons: [], changes };
}
