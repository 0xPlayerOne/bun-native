import { cp, mkdir, readFile, readdir, writeFile, copyFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const resources = join(root, 'native/cef-host/resources');
await mkdir(join(resources, 'backend'), { recursive: true });
await cp(join(root, 'examples/cef/public'), join(resources, 'public'), { recursive: true });
for (const [entry, name] of [['scripts/cef-bootstrap.ts', 'main.js'], ['examples/cef/main.ts', 'application.js']] as const) {
  const result = await Bun.build({ entrypoints: [join(root, entry)], outdir: join(resources, 'backend'), naming: name, target: 'bun', format: 'esm', minify: false });
  if (!result.success) throw new Error(`CEF application build failed: ${result.logs.join('\n')}`);
}
const bun = join(resources, process.platform === 'win32' ? 'bun.exe' : 'bun');
await copyFile(process.execPath, bun); if (process.platform !== 'win32') await chmod(bun, 0o755);
const files: Record<string, { bytes: number; sha256: string }> = {};
for (const path of (await readdir(join(resources, 'public'))).sort()) {
  if (path === 'assets.json') continue;
  const data = await readFile(join(resources, 'public', path)); files[path] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}
await writeFile(join(resources, 'public/assets.json'), JSON.stringify(files, null, 2) + '\n');
await writeFile(join(resources, 'runtime.json'), JSON.stringify({ schema: 1, protocol: 1, bun_version: Bun.version, cef_version: '154.0.34' }) + '\n');
console.log(JSON.stringify({ resources, nativeCompilation: false, bun: Bun.version, publicAssets: Object.keys(files) }));
