/** Real process/compile qualification only. Does not execute a browser or desktop. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts';
import { assertExpectedCompileFailure } from '../benchmarks/lib/desktop-edits.ts';
const root = resolve(import.meta.dir, '..');
const directory = join(root, '.bunly/benchmarks/command-qualification', randomUUID());
await mkdir(directory, { recursive: true });
const project = join(directory, 'source'); await mkdir(project);
const cases: { name: string; passed: boolean; evidence: string }[] = [];
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); cases.push({ name, passed: true, evidence: 'Executed and checked real process observation' }); }
  catch (error) { cases.push({ name, passed: false, evidence: String(error).slice(0, 4096) }); }
}
const command = (name: string, script: string, timeoutMs = 3000, extras: { signal?: AbortSignal; env?: Record<string, string>; redact?: string[] } = {}) =>
  observedCommand([process.execPath, '-e', script], { cwd: project, output: join(directory, name + '.json'), timeoutMs, ...extras });
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
await check('stdout-and-stderr', async () => {
  const value = await command('stdout-and-stderr', "console.log('build stdout marker');console.error('build stderr marker')").result;
  assertCleanCommand(value); assert(value.stdoutTail.includes('build stdout marker') && value.stderr.includes('build stderr marker'), 'Missing actual build output');
});
await check('actual-compiler-rejection', async () => {
  await writeFile(join(project, 'revision.ts'), 'export const revision = ;\n');
  const value = await observedCommand([process.execPath, 'build', join(project, 'revision.ts'), '--outfile', join(project, 'out.js')],
    { cwd: project, output: join(directory, 'actual-compiler-rejection.json'), timeoutMs: 3000 }).result;
  assertExpectedCompileFailure(value);
});
await check('hung-child-deadline', async () => {
  const value = await command('hung-child-deadline', 'setInterval(() => {}, 1000)', 150).result;
  assert(value.timedOut && value.exitCode !== 0 && value.cleanupSurvivors.length === 0, 'Hung child was not terminated/reaped');
});
await check('cooperative-observer-cancellation', async () => {
  const controller = new AbortController(), marker = join(project, 'ready');
  const child = command('cooperative-observer-cancellation', `await Bun.write(${JSON.stringify(marker)}, 'ready');setInterval(() => {}, 1000)`, 3000, { signal: controller.signal });
  try {
    const deadline = performance.now() + 2000;
    while (!await Bun.file(marker).exists()) { if (performance.now() > deadline) throw new Error('Child did not start'); await Bun.sleep(10); }
    controller.abort(); const value = await child.result;
    assert(value.cancelled && !value.timedOut && value.cleanupSurvivors.length === 0, 'Cancellation lost child cleanup');
  } finally { controller.abort(); await child.result; }
});
await check('orphan-detection-and-cleanup', async () => {
  const script = `const child=Bun.spawn([process.execPath,'-e','setInterval(() => {}, 1000)'],{stdout:'ignore',stderr:'ignore'});child.unref();setTimeout(()=>process.exit(0),250);`;
  const value = await command('orphan-detection-and-cleanup', script).result;
  assert(value.exitCode === 0 && value.observedOrphans.length > 0 && value.cleanupSurvivors.length === 0, 'Intentional orphan was not detected and cleaned');
});
await check('output-overflow', async () => {
  const value = await command('output-overflow', "process.stdout.write('x'.repeat(2200000));setTimeout(()=>{},200)").result;
  assert(value.outputOverflow && value.cleanupSurvivors.length === 0, 'Output overflow passed silently');
});
await check('credential-redaction', async () => {
  const secret = randomBytes(24).toString('hex');
  const child = command('credential-redaction', "console.error(process.env.BUNLY_TEST_REDACTION)", 3000, { env: { BUNLY_TEST_REDACTION: secret }, redact: [secret] });
  const value = await child.result; assertCleanCommand(value);
  assert(!JSON.stringify(value).includes(secret) && !(await readFile(child.path, 'utf8')).includes(secret) && value.stderr.includes('[redacted]'), 'Credential survived diagnostic redaction');
});
await rm(project, { recursive: true, force: true });
const result = { schema: 1, kind: 'measurement-process-qualification-not-desktop', bun: Bun.version, platform: process.platform,
  passed: cases.every(row => row.passed), cases };
await writeFile(join(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, output: join(directory, 'summary.json') }, null, 2));
process.exitCode = result.passed ? 0 : 1;
