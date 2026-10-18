/** Contributor-only ABI qualification. Never invoked by ordinary application builds. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectCefLibrary } from '../benchmarks/lib/cef-identity.ts';
import { assertCleanCommand, observedCommand, validateCommandObservation } from '../benchmarks/lib/observed-command.ts';
if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('ABI fixture compiler is only specified for Linux/macOS; no Windows result is claimed');
const compiler = Bun.which(process.env['CC'] ?? 'cc');
if (!compiler) throw new Error('Contributor ABI test requires an explicitly available C compiler');
const root = resolve(import.meta.dir, '..'), directory = await mkdtemp(join(tmpdir(), 'bunly-cef-abi-'));
let cleanupSafe = true;
try {
  for (const crash of [false, true]) {
    const library = join(directory, crash ? 'abort.so' : 'version.so');
    const command = [compiler, process.platform === 'darwin' ? '-dynamiclib' : '-shared', '-fPIC',
      ...(crash ? ['-DFIXTURE_ABORT'] : []), join(root, 'tests/fixtures/cef-inspector/version.c'), '-o', library];
    const build = await observedCommand(command, { cwd: root, output: join(directory, crash ? 'build-abort.json' : 'build.json'), timeoutMs: 15000 }).result;
    if (build.cleanupSurvivors.length) cleanupSafe = false;
    assertCleanCommand(build);
    const digest = createHash('sha256').update(await readFile(library)).digest('hex');
    if (!crash) {
      const value = await inspectCefLibrary(library, digest, join(directory, 'version.json'));
      if (value.chromiumVersion !== '123.0.4567.89') throw new Error('Incorrect ABI values');
      let rejected = false;
      try { await inspectCefLibrary(library, '0'.repeat(64), join(directory, 'wrong-hash.json')); } catch { rejected = true; }
      if (!rejected) throw new Error('Wrong binary digest was accepted');
      const badHash = validateCommandObservation(JSON.parse(await readFile(join(directory, 'wrong-hash.json'), 'utf8')));
      cleanupSafe = cleanupSafe && badHash.cleanupSurvivors.length === 0;
      assertCleanCommand(badHash, 1);
    } else {
      let rejected = false;
      try { await inspectCefLibrary(library, digest, join(directory, 'abort.json')); } catch { rejected = true; }
      if (!rejected) throw new Error('Native crash was accepted as valid identity');
      const crashed = validateCommandObservation(JSON.parse(await readFile(join(directory, 'abort.json'), 'utf8')));
      cleanupSafe = cleanupSafe && crashed.cleanupSurvivors.length === 0;
      assertCleanCommand(crashed, -6);
    }
  }
  console.log(JSON.stringify({ kind: 'native-abi-fixture-not-cef', passed: true, cases: 3 }));
} finally {
  // Every library load is awaited through the process observer before cleanup.
  // Native fixture code creates no child processes of its own.
  if (cleanupSafe) await rm(directory, { recursive: true, force: true });
}
