import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cpus, totalmem, release } from 'node:os';
import { createHash } from 'node:crypto';
import { developmentIdentity, developmentScenario, DEVELOPMENT_SCENARIOS } from '../benchmarks/adapters/development/driver.ts';
import { validateRun, reportRun, type BenchmarkRun, type Trial } from '../benchmarks/lib/results.ts';
import { schedule } from '../benchmarks/lib/statistics.ts';
const root = resolve(import.meta.dir, '..');
const trials: Trial[] = []; const hash = createHash('sha256');
for (const file of ['server.ts.txt', 'revision.ts.txt']) { hash.update(file + '\0'); hash.update(Buffer.from(await Bun.file(join(root, 'benchmarks/fixtures/development', file)).arrayBuffer())); }
hash.update(Buffer.from(await Bun.file(join(root, 'benchmarks/fixtures/long-command.ts')).arrayBuffer()));
for (const warmup of [true, false]) {
  for (const { trial } of schedule(['bun-watch'], warmup ? 1 : 3, 42)) {
    for (const scenario of DEVELOPMENT_SCENARIOS) {
      try { trials.push({ variant: 'bun-watch', scenario, trial, warmup, ...await developmentScenario(scenario) }); }
      catch (error) { trials.push({ variant: 'bun-watch', scenario, trial, warmup, status: 'failed', reason: String(error), correctness: { passed: false, details: 'Real fixture failed' }, metrics: {} }); }
    }
  }
}
const run: BenchmarkRun = { schema: 1, createdAt: new Date().toISOString(), fixtureSha256: hash.digest('hex'), seed: 42, repetitions: 3, warmups: 1,
  scenarios: [...DEVELOPMENT_SCENARIOS], variants: [developmentIdentity], sourceCommit: process.env['GITHUB_SHA'] ?? 'local-uncommitted',
  parameters: { service: 'bare-bun-watch', commandItems: 128, retainedState: 'fixture-owned-json-not-runtime-memory' },
  environment: { runClass: process.env['CI'] ? 'ci-smoke' : 'local-smoke', target: `${process.platform}-${process.arch}`, os: release(), cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length || 1, memoryBytes: totalmem(), gpu: 'none', display: 'none', power: 'unknown', machineLabel: 'unknown' }, trials };
validateRun(run);
const directory = join(root, '.bunly/benchmarks'); await mkdir(directory, { recursive: true });
await writeFile(join(directory, `development-${process.platform}-${process.arch}.json`), JSON.stringify(run, null, 2) + '\n');
console.log(JSON.stringify({ passed: trials.every(trial => trial.status === 'passed'), summary: reportRun(run) }));
if (trials.some(trial => trial.status !== 'passed')) throw new Error('Development fixture qualification failed');
