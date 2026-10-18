/** Mirin CEF and Butter system-webview subsets of the shared desktop edit protocol. */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { loadWorkbenchAssets } from '../../../scripts/workbench.ts';
import { runDesktopEdits, type DesktopEditAdapter, type DesktopEditResult } from '../../lib/desktop-edits.ts';
import { desktopEditStages } from '../../lib/desktop-report.ts';
import { BYTE_CATEGORIES, directoryBytes, fileBytes, unavailableBytes, type ByteObservation } from '../../lib/accounting.ts';
import { observedCommand, observationsPermitFixtureRemoval, type CommandObservation } from '../../lib/observed-command.ts';
import { referenceInstallation, REFERENCE_PACKAGES, type ReferenceInstallation, type ReferenceName } from './packages.ts';
import { cefIdentityFromObservation, type CefIdentity } from '../../lib/cef-identity.ts';
import { referenceArtifact, type ReferenceArtifact } from './layout.ts';
const root = resolve(import.meta.dir, '../../..'), templates = join(root, 'benchmarks/fixtures/desktop-edit');
export async function referenceDesktopTrial(name: ReferenceName, options: {
  readonly installation: string; readonly lockSha256: string; readonly output: string; readonly signal?: AbortSignal;
}) {
  if (!Object.hasOwn(REFERENCE_PACKAGES, name)) throw new Error('Unknown reference');
  const spec = REFERENCE_PACKAGES[name], output = resolve(options.output);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const parent = join(root, '.bunly/reference-fixtures'); await mkdir(parent, { recursive: true, mode: 0o700 });
  const project = await mkdtemp(join(parent, name + '-'));
  const commands: { phase: string; report: string; observation: CommandObservation | null }[] = [];
  let result: DesktopEditResult | null = null, installation: ReferenceInstallation | null = null;
  let failure: string | null = null, retainedFixture: string | null = null;
  let artifact: ReferenceArtifact | undefined;
  let engineIdentity: CefIdentity | null = null;
  let bytes: readonly ByteObservation[] = BYTE_CATEGORIES.map(category => unavailableBytes(category, 'This edit run did not collect this distribution category'));
  try {
    installation = await referenceInstallation(name, options.installation, options.lockSha256);
    await symlink(installation.nodeModules, join(project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const state = { token: randomBytes(24).toString('hex'), counter: 17 }, statePath = join(project, 'fixture-state.json');
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    await mkdir(join(project, 'src')); await mkdir(join(project, 'home'));
    for (const file of ['host.ts', name + '.ts']) await copyFile(join(templates, file + '.txt'), join(project, 'src', file));
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'bunly-private-reference-workbench', version: '0.0.0', private: true, type: 'module' }));
    await writeFile(join(project, 'index.html'), '<!doctype html><title>Reference bootstrap</title><p>Private benchmark bootstrap</p>');
    if (name === 'mirin') {
      await copyFile(join(templates, 'mirin.config.ts.txt'), join(project, 'mirin.config.ts'));
      await writeFile(join(project, 'vite.config.ts'), 'export default { build: { outDir: "dist" } };\n');
    } else await copyFile(join(templates, 'butter.yaml.txt'), join(project, 'butter.yaml'));
    const environment = { HOME: join(project, 'home'), USERPROFILE: join(project, 'home'), BUN_INSTALL_CACHE_DIR: join(project, 'home/bun-cache'),
      MIRIN_SIGN_IDENTITY: '', MIRIN_RELEASE_BASE_URL: '', MIRIN_RELEASE_CHANNEL: '', MIRIN_APP_VERSION: '', PATH: dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + (process.env['PATH'] ?? '') };
    function command(phase: string, args: readonly string[], env: Record<string, string> = {}, redact: readonly string[] = [], timeoutMs = 30000) {
      const report = `${String(commands.length).padStart(3, '0')}-${phase}.json`, index = commands.length;
      commands.push({ phase, report, observation: null });
      const child = observedCommand(args, { cwd: project, output: join(output, report), env: { ...environment, ...env }, timeoutMs, redact,
        ...(options.signal ? { signal: options.signal } : {}) });
      const observed = child.result.then(observation => { commands[index] = { phase, report, observation }; return observation; });
      void observed.catch(() => {}); return { result: observed, path: child.path };
    }
    const entry = installation.entry;
    const adapter: DesktopEditAdapter = {
      kind: 'desktop', artifactKind: name === 'butter' ? 'standalone-executable' : 'application-directory', framework: spec.framework, version: spec.version,
      state, html: await readFile(join(templates, 'index.html'), 'utf8'), javascript: await readFile(join(templates, 'client.js'), 'utf8'),
      workbenchAssets: await loadWorkbenchAssets(),
      async writeRevision(revision) { await writeFile(join(project, 'src/revision.ts'), revision === 'broken' ? 'export const revision = ;\n' : `export const revision = '${revision}';\n`); },
      async verifyState() { if (await readFile(statePath, 'utf8') !== JSON.stringify(state)) throw new Error('Reference fixture state changed'); },
      async build() {
        const observation = await command('build', [process.execPath, entry, ...spec.build], {}, [], 240000).result;
        if (observation.exitCode === 0 && !observation.timedOut && !observation.cancelled) artifact = await referenceArtifact(name, project);
        return observation;
      },
      async launch(config) {
        if (!artifact) throw new Error('No built reference artifact');
        return command('app', [artifact.executable], { BUNLY_EDIT_ORIGIN: config.origin, BUNLY_EDIT_LAUNCH: config.launch,
          BUNLY_EDIT_HOST_TOKEN: config.hostToken, BUNLY_EDIT_RENDERER_TOKEN: config.rendererToken, BUNLY_EDIT_STATE: statePath,
          BUNLY_EDIT_PROFILE: join(project, 'profile'), BUNLY_EDIT_FRAME_ORIGIN: config.workbenchOrigin ?? '' }, [config.hostToken, config.rendererToken], 35000);
      },
    };
    result = await runDesktopEdits(adapter, options.signal ? { signal: options.signal } : {});
    if (artifact) {
      const description = 'Actual ' + spec.framework + ' artifact after the edit sequence; not installer, network bytes or RAM';
      const installed = artifact.kind === 'standalone-executable' ? await fileBytes('installed', artifact.application, description) : await directoryBytes('installed', artifact.application, description);
      bytes = bytes.map(row => row.category === 'installed' ? installed : row);
      if (name === 'mirin') {
        const library = await realpath(join(artifact.application, process.platform === 'darwin'
          ? 'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
          : process.platform === 'win32' ? 'libcef.dll' : 'libcef.so'));
        const nativeBytes = await fileBytes('installed', library, 'Hash-pin the exact built CEF binary before isolated version inspection');
        const hash = nativeBytes.sha256!;
        const identity = await command('cef-identity', [process.env['PYTHON'] ?? 'python', join(root, 'scripts/probe_cef_identity.py'), '--library', library, '--sha256', hash], {}, [], 15000).result;
        engineIdentity = cefIdentityFromObservation(identity, hash);
      }
    }
  } catch (error) { failure = error instanceof Error ? error.message.slice(0, 4096) : 'Reference setup failed'; }
  finally {
    if (observationsPermitFixtureRemoval(commands.map(row => row.observation))) {
      await rm(project, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => { retainedFixture = relative(root, project); failure = 'Reference fixture cleanup failed'; });
    } else { retainedFixture = relative(root, project); failure = 'Reference process cleanup not established; fixture retained'; }
  }
  return { schema: 1, adapter: name, framework: spec.framework, version: spec.version, referenceSource: spec.sourceCommit,
    runClass: 'local-smoke', engineIdentity, processSandbox: 'unverified', passed: failure === null && result?.passed === true, result, setupFailure: failure, retainedFixture,
    installation: installation ? { packages: installation.packages, lockSha256: installation.lockSha256, sourceVerified: installation.sourceVerified } : null,
    artifact: artifact ? { kind: artifact.kind, name: basename(artifact.application) } : null, stages: desktopEditStages(result, failure), bytes, commands,
    limitations: ['No controlled performance eligibility', 'Source-reference pin does not authenticate registry binary provenance',
      'CEF identity, when present, comes from the inspected final artifact; it does not verify process sandboxing',
      'System-webview version remains unverified; no CEF substitution is used',
      ...(name === 'butter' ? ['System-webview profile, not CEF; the bootstrap window is included', 'Competitor may compile its native shim; this cost is not removed'] : ['Upstream build may combine native artifact acquisition, assembly and ad-hoc signing; no invented split timing'])] };
}
