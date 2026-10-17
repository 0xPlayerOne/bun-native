import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { electrobunIdentity, electrobunScenario } from '../benchmarks/adapters/electrobun/driver.ts';
import { electrobunLayout } from '../benchmarks/adapters/electrobun/layout.ts';
import { SCENARIOS } from '../benchmarks/lib/mock-scenarios.ts';
import { inventory } from '../benchmarks/lib/inventory.ts';
import { reportRun, validateRun, type BenchmarkRun, type Trial } from '../benchmarks/lib/results.ts';
const layout = await electrobunLayout();
const directory = join(layout.root, '.bunly/benchmarks'); await mkdir(directory, { recursive: true });
const payload = await inventory(layout.application);
await writeFile(join(directory, 'electrobun-inventory.json'), JSON.stringify({ application: layout.relativeApplication, ...payload }, null, 2));
const hash = createHash('sha256');
for (const path of ['benchmarks/fixtures/data.ts', 'benchmarks/fixtures/server.ts', 'benchmarks/fixtures/package.json', 'examples/workbench/ui.ts', 'examples/workbench/workbench.html', 'examples/workbench/service.ts']) {
  hash.update(path + '\0'); hash.update(await readFile(join(layout.root, path))); hash.update('\0');
}
const scenarios = ['app-launch', ...SCENARIOS]; const trials: Trial[] = [];
for (const warmup of [true, false]) for (let trial = 0; trial < (warmup ? 1 : 3); trial++) {
  for (const scenario of scenarios) {
    try { trials.push({ variant: 'electrobun', scenario, trial, warmup, ...await electrobunScenario(scenario) }); }
    catch (error) {
      const result: Trial = { variant: 'electrobun', scenario, trial, warmup, status: 'failed', reason: String(error), correctness: { passed: false, details: 'Actual Electrobun execution failed' }, metrics: {} };
      trials.push(result); console.error(JSON.stringify({ failedTrialIncludingWarmup: result }));
    }
  }
}
const run: BenchmarkRun = { schema: 1, createdAt: new Date().toISOString(), fixtureSha256: hash.digest('hex'), sourceCommit: process.env['GITHUB_SHA'] ?? 'local', seed: 42, repetitions: 3, warmups: 1,
  scenarios, variants: [electrobunIdentity], parameters: { lines: 256, columns: 80, terminal: 'xterm-5.5.0', bundleWGPU: false, profile: 'framework-default-app-identifier', completionTransport: 'local-http-not-native-rpc' },
  environment: { runClass: process.env['CI'] ? 'ci-smoke' : 'local-smoke', target: `${process.platform}-${process.arch}`, os: release(), cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length || 1, memoryBytes: totalmem(), gpu: 'unknown', display: 'unknown', power: 'unknown', machineLabel: 'unknown' }, trials };
validateRun(run);
await writeFile(join(directory, 'electrobun.json'), JSON.stringify(run, null, 2) + '\n');
console.log(JSON.stringify({ runtime: electrobunIdentity, installedFileBytes: payload.bytes, summary: reportRun(run) }));
if (trials.some(trial => trial.status === 'failed')) throw new Error('Electrobun qualification failed; raw failures include warmups');
