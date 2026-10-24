/** Application bundling only. CEF/native artifacts are built separately by contributors. */
import {
  cp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  copyFile,
  chmod,
  lstat,
  mkdtemp,
  rename,
  rm,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dir, '..'),
  parent = join(root, 'native/cef-host')
const resources = join(parent, 'resources')
const args = process.argv.slice(2)
if (
  args.some(
    (argument) => !argument.startsWith('--dev-origin=') && !argument.startsWith('--application=')
  ) ||
  args.filter((argument) => argument.startsWith('--dev-origin=')).length > 1 ||
  args.filter((argument) => argument.startsWith('--application=')).length > 1
)
  throw new Error(
    'Only --dev-origin=http://127.0.0.1:PORT and --application=main|sessions|transport are supported'
  )
const developmentOrigin = args
  .find((argument) => argument.startsWith('--dev-origin='))
  ?.slice('--dev-origin='.length)
const application =
  args.find((argument) => argument.startsWith('--application='))?.slice('--application='.length) ??
  'main'
if (!['main', 'sessions', 'transport'].includes(application))
  throw new Error('Unknown CEF fixture application')
if (developmentOrigin !== undefined) {
  const url = new URL(developmentOrigin)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.origin !== developmentOrigin
  )
    throw new Error('Development origin must be an exact explicit loopback origin')
}
const stage = await mkdtemp(join(parent, '.resources-stage-'))
try {
  await mkdir(join(stage, 'backend'))
  await cp(join(root, 'examples/cef/public'), join(stage, 'public'), {
    recursive: true,
    dereference: false,
  })
  const browser = await Bun.build({
    entrypoints: [
      join(root, 'examples/cef/rpc-client.ts'),
      join(root, 'examples/cef/rpc-lifecycle.ts'),
      join(root, 'examples/cef/transport-client.ts'),
    ],
    outdir: join(stage, 'public'),
    naming: '[name].js',
    target: 'browser',
    format: 'esm',
    minify: false,
  })
  if (!browser.success) throw new Error(`CEF renderer RPC build failed: ${browser.logs.join('\n')}`)
  for (const [entry, name] of [
    ['scripts/cef-bootstrap.ts', 'main.js'],
    [`examples/cef/${application}.ts`, 'application.js'],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [join(root, entry)],
      outdir: join(stage, 'backend'),
      naming: name,
      target: 'bun',
      format: 'esm',
      minify: false,
    })
    if (!result.success) throw new Error(`CEF application build failed: ${result.logs.join('\n')}`)
  }
  const bun = join(stage, process.platform === 'win32' ? 'bun.exe' : 'bun')
  await copyFile(process.execPath, bun)
  if (process.platform !== 'win32') await chmod(bun, 0o755)
  const files: Record<string, { bytes: number; sha256: string }> = {}
  async function inventory(prefix = '') {
    for (const name of (await readdir(join(stage, 'public', prefix))).sort()) {
      const path = prefix ? prefix + '/' + name : name,
        full = join(stage, 'public', path),
        stat = await lstat(full)
      if (stat.isSymbolicLink()) throw new Error('Public asset symlinks are not permitted')
      if (stat.isDirectory()) {
        await inventory(path)
        continue
      }
      if (path === 'assets.json' || !stat.isFile())
        throw new Error('Reserved or nonregular public input')
      const bytes = await readFile(full)
      files[path] = {
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    }
  }
  await inventory()
  await writeFile(join(stage, 'public/assets.json'), JSON.stringify(files, null, 2) + '\n')
  await writeFile(
    join(stage, 'runtime.json'),
    JSON.stringify({
      schema: 1,
      protocol: 1,
      bun_version: Bun.version,
      cef_version: '156.0.7',
      maintenance_protocol: 1,
      ...(developmentOrigin ? { development_origin: developmentOrigin } : {}),
    }) + '\n'
  )
  // Only this generated tree is replaced, so deleted sources cannot survive a rebuild.
  const old = resources + '.previous-' + crypto.randomUUID()
  let previous = false
  try {
    await rename(resources, old)
    previous = true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  try {
    await rename(stage, resources)
  } catch (e) {
    if (previous) await rename(old, resources)
    throw e
  }
  if (previous) await rm(old, { recursive: true })
  console.log(
    JSON.stringify({
      resources,
      nativeCompilation: false,
      bun: Bun.version,
      developmentOrigin: developmentOrigin ?? null,
      application,
      publicAssets: Object.keys(files),
    })
  )
} finally {
  await rm(stage, { recursive: true, force: true })
}
