import { lstat, readdir } from 'node:fs/promises';
import { join, resolve, basename, relative } from 'node:path';
export async function electrobunLayout() {
  if (process.platform !== 'darwin') throw new Error('Electrobun baseline launch layout is currently qualified on macOS only');
  const root = resolve(import.meta.dir, '../../..');
  const project = join(root, '.bunly/benchmarks/electrobun-project');
  const applications: string[] = [];
  async function visit(path: string, depth: number): Promise<void> {
    if (depth > 3) return;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(path, entry.name);
      if (entry.name.endsWith('.app')) applications.push(child); else await visit(child, depth + 1);
    }
  }
  await visit(join(project, 'build'), 0);
  if (applications.length !== 1) throw new Error('Expected one prepared Electrobun application, got ' + applications.length);
  const application = applications[0]!;
  const info = join(application, 'Contents/Info.plist');
  const result = Bun.spawnSync(['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleExecutable', info]);
  const executableName = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !executableName || basename(executableName) !== executableName) throw new Error('Invalid prepared application executable');
  const executable = join(application, 'Contents/MacOS', executableName);
  if (!(await lstat(executable)).isFile()) throw new Error('Missing regular native launcher');
  return { root, project, application, executable, relativeApplication: relative(root, application) };
}
