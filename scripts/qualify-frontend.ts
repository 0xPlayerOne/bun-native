import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { assertEditApplied, assertFailedEdit } from '../benchmarks/lib/revision.ts';

const root = resolve(import.meta.dir, '..');
const browser = process.env['BUNLY_BENCH_CHROMIUM'];
if (!browser) throw new Error('Set BUNLY_BENCH_CHROMIUM to a known installed Chromium executable; no browser is downloaded or silently replaced');
const directory = join(root, '.bunly/benchmarks'); await mkdir(directory, { recursive: true });
const output = join(directory, `frontend-${process.platform}-${process.arch}.json`);
const child = Bun.spawn([process.env['PYTHON'] ?? 'python', join(root, 'benchmarks/adapters/frontend/driver.py'),
  '--bun', process.execPath, '--chromium', browser, '--output', output], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
const code = await child.exited;
const report = JSON.parse(await readFile(output, 'utf8')) as { passed: boolean; trials: { status: string; observations: unknown[]; diagnostic: unknown }[]; plan: { expectedExecutions: number } };
if (code !== 0 || report.passed !== true || report.trials.length !== report.plan.expectedExecutions) throw new Error('Frontend qualification failed; inspect the retained report. No alternate browser or no-sandbox retry is performed');
for (const trial of report.trials) {
  if (trial.status !== 'passed' || trial.observations.length !== 4) throw new Error('Incomplete frontend proof');
  const [initial, changed, failed, repaired] = trial.observations;
  assertEditApplied(initial, changed, 'edited', 'frontend-hmr');
  assertFailedEdit(changed, failed, trial.diagnostic);
  assertEditApplied(failed, repaired, 'repaired', 'frontend-hmr');
}
console.log('Frontend source edit, failed edit and repair verified without document replacement. Not a desktop benchmark.');
