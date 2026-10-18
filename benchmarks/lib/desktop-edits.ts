/** Executes source edits against a real adapter; injected test adapters are explicit. */
import type { FixtureAssets } from '../fixtures/server.ts';
import { createWorkbenchDesktopProbe } from './workbench-desktop.ts';
import { performance } from 'node:perf_hooks';
import { createDesktopProbe, assertDesktopReplacement, type DesktopLaunch, type DesktopObservation } from './desktop-probe.ts';
import { assertCleanCommand, type CommandObservation, type ObservedCommand } from './observed-command.ts';
export const DESKTOP_EDIT_STEPS = ['initial-build', 'initial-launch', 'backend-edit', 'failed-edit', 'repair'] as const;
export type DesktopStepName = typeof DESKTOP_EDIT_STEPS[number];
export interface DesktopStep {
  readonly name: DesktopStepName; readonly status: 'passed' | 'failed' | 'not-executed';
  readonly elapsedMs: number | null; readonly reason: string;
  readonly observations: readonly DesktopObservation[];
  readonly timings: Readonly<Record<string, number>>;
}
export interface DesktopEditAdapter {
  readonly kind: 'desktop' | 'harness-test'; readonly artifactKind: 'main-bundle' | 'application-directory' | 'standalone-executable'; readonly framework: string; readonly version: string;
  readonly html: string; readonly javascript: string;
  readonly workbenchAssets?: FixtureAssets;
  readonly state: { readonly token: string; readonly counter: number };
  writeRevision(revision: 'initial' | 'edited' | 'broken' | 'repaired'): Promise<void>;
  verifyState(): Promise<void>;
  build(): Promise<CommandObservation>;
  launch(configuration: DesktopLaunch): Promise<ObservedCommand>;
}
export interface DesktopEditResult {
  readonly passed: boolean; readonly kind: 'desktop' | 'harness-test'; readonly artifactKind: 'main-bundle' | 'application-directory' | 'standalone-executable';
  readonly steps: readonly DesktopStep[]; readonly cleanupFailures: readonly string[];
}
export function assertExpectedCompileFailure(report: CommandObservation): void {
  if (report.timedOut || report.cancelled || report.cleanupSurvivors.length || report.outputOverflow || report.observedOrphans.length || report.exitCode <= 0) throw new Error('Expected clean compiler failure, not success or a process failure');
  const diagnostic = [...report.stdoutTail, ...report.stderr].join('\n');
  if (!/revision\.(?:ts|js|cjs)\b/.test(diagnostic) || !/SyntaxError|ParseError|Unexpected\s+['"]?;|Expected\s+(?:expression|identifier)/i.test(diagnostic)) throw new Error('No diagnostic for the intentionally invalid revision source');
}
/** Reports only allowlisted engine error classes, never raw page diagnostics. */
export function desktopExitFailure(report: CommandObservation): Error {
  const known = ['ERR_BLOCKED_BY_ADMINISTRATOR', 'ERR_CONNECTION_REFUSED', 'ERR_CERT_AUTHORITY_INVALID',
    'ERR_ABORTED', 'ERR_FILE_NOT_FOUND', 'ERR_NAME_NOT_RESOLVED', 'APPLICATION_FAILED'];
  let code: string | undefined;
  for (const line of [...report.stdoutTail, ...report.stderr]) {
    try {
      const value = JSON.parse(line);
      if (value?.event === 'fixture-failure' && known.includes(value.code)) code = value.code;
    } catch { /* Plain compiler/browser messages stay in the bounded raw report. */ }
  }
  return new Error('Desktop exited before readiness' + (code ? ': ' + code : ''));
}
/** Every started command is reaped before a replacement or fixture cleanup. */
export async function runDesktopEdits(adapter: DesktopEditAdapter, options: { readonly readinessTimeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<DesktopEditResult> {
  if (adapter.kind === 'desktop' && !adapter.workbenchAssets) throw new Error('Desktop qualification requires the shared workbench');
  const steps: DesktopStep[] = [], cleanupFailures: string[] = [];
  let active: { probe: Awaited<ReturnType<typeof createDesktopProbe>>; command: ObservedCommand } | undefined;
  let last: DesktopObservation | undefined;
  async function stop(): Promise<void> {
    const owned = active; if (!owned) return;
    active = undefined; owned.probe.requestQuit();
    try { const result = await owned.command.result; assertCleanCommand(result); }
    finally { await owned.probe.close(); }
  }
  async function launch(revision: string): Promise<DesktopObservation> {
    const probeOptions = { revision, state: adapter.state.token, counter: adapter.state.counter,
      framework: adapter.framework, version: adapter.version, html: adapter.html, javascript: adapter.javascript,
      ...(options.readinessTimeoutMs === undefined ? {} : { timeoutMs: options.readinessTimeoutMs }) };
    const probe = adapter.workbenchAssets ? await createWorkbenchDesktopProbe(probeOptions, adapter.workbenchAssets) : await createDesktopProbe(probeOptions);
    let command: ObservedCommand;
    try { command = await adapter.launch(probe.configuration); }
    catch (error) { await probe.close(); throw error; }
    active = { probe, command };
    // A process exit before rendered readiness cannot become a passed launch.
    return await Promise.race([probe.completion, command.result.then(report => { throw desktopExitFailure(report); })]);
  }
  for (const name of DESKTOP_EDIT_STEPS) {
    if (steps.some(row => row.status !== 'passed')) {
      steps.push({ name, status: 'not-executed', elapsedMs: null, reason: 'Prior step failed; no retry or zero timing', observations: [], timings: {} }); continue;
    }
    const start = performance.now(), timings: Record<string, number> = {}, observations: DesktopObservation[] = [];
    try {
      options.signal?.throwIfAborted();
      if (name === 'initial-build') {
        await adapter.writeRevision('initial'); const t = performance.now();
        assertCleanCommand(await adapter.build()); timings['buildAndReapMs'] = performance.now() - t;
      } else if (name === 'initial-launch') {
        last = await launch('initial'); observations.push(last);
      } else {
        const revision = name === 'backend-edit' ? 'edited' : name === 'failed-edit' ? 'broken' : 'repaired';
        const write = performance.now(); await adapter.writeRevision(revision); timings['sourceWriteMs'] = performance.now() - write;
        const teardown = performance.now(); await stop(); timings['priorAppStopMs'] = performance.now() - teardown;
        const buildStart = performance.now(), build = await adapter.build(); timings['buildAndReapMs'] = performance.now() - buildStart;
        if (name === 'failed-edit') assertExpectedCompileFailure(build);
        else {
          assertCleanCommand(build); const ready = performance.now(), next = await launch(revision);
          timings['launchToRendererMs'] = performance.now() - ready;
          if (!last) throw new Error('Missing prior desktop observation');
          assertDesktopReplacement(last, next, revision); observations.push(last, next); last = next;
        }
      }
      await adapter.verifyState();
      steps.push({ name, status: 'passed', elapsedMs: performance.now() - start,
        reason: name === 'failed-edit' ? 'Observed a clean compiler rejection of the changed source; no replacement launched' : 'Executed and validated actual revision/state and renderer acknowledgement where applicable', observations, timings });
    } catch (error) {
      steps.push({ name, status: 'failed', elapsedMs: performance.now() - start, reason: error instanceof Error ? error.message : 'Desktop step failed', observations, timings });
      try { await stop(); } catch (cleanup) { cleanupFailures.push(cleanup instanceof Error ? cleanup.message : 'Cleanup failed'); }
    }
  }
  try { await stop(); } catch (error) { cleanupFailures.push(error instanceof Error ? error.message : 'Cleanup failed'); }
  return { passed: cleanupFailures.length === 0 && steps.every(row => row.status === 'passed'), kind: adapter.kind, artifactKind: adapter.artifactKind, steps, cleanupFailures };
}
