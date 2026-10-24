/** Actual full-runtime HTTPS acquisition and offline execution; ephemeral test keys, no publication. */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile, lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { packageCefRuntime } from '../packages/artifacts/src/cef-pack.ts'
import {
  resolveCefRuntime,
  withCefRuntime,
  removeCefRuntime,
} from '../packages/artifacts/src/cef-cache.ts'
import {
  parseCefManifest,
  type CefRuntimeIdentity,
} from '../packages/artifacts/src/cef-manifest.ts'
import { acceptNativeSmoke } from '../benchmarks/lib/cef-acceptance.ts'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
const root = resolve(import.meta.dir, '..'),
  [sourceApp] = process.argv.slice(2)
if (process.platform !== 'darwin' || process.arch !== 'arm64' || !sourceApp)
  throw new Error(
    'This full native acquisition qualification currently requires the darwin-arm64 fixture app argument'
  )
const parent = join(root, '.bunly/m3/acquisition')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'run-')),
  output = join(work, 'report.json'),
  commands: unknown[] = []
const report: Record<string, unknown> = {
  schema: 1,
  profile: 'full-cef-https-and-offline-native-qualification',
  passed: false,
  commands,
  sourceCommit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim(),
  sourceClean:
    Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: root }).stdout.toString().trim() === '',
  productionTrust: false,
}
const identity: CefRuntimeIdentity = {
  kind: 'cef-runtime',
  version: '0.1.0-dev.0',
  abi: 1,
  target: 'darwin-arm64',
  bun: Bun.version,
  cef: '156.0.7',
  chromium: '156.0.8078.17',
  cefRs: 'a46b48c6221f99414a5c6b37ff86491772f9b0a2',
  nativeToolchain: 'rust-1.91.0',
}
async function command(name: string, args: string[], cwd = root) {
  const data = await observedCommand(args, {
    cwd,
    output: join(work, name + '.process.json'),
    timeoutMs: 180000,
  }).result
  commands.push({ name, observation: data })
  assertCleanCommand(data)
  return data
}
let server: ReturnType<typeof Bun.serve> | undefined
try {
  const payload = join(work, 'payload')
  await mkdir(payload)
  await cp(await realpath(sourceApp), join(payload, 'Bunly.app'), {
    recursive: true,
    dereference: false,
  })
  // Independent copies and inside-out local signing are delegated to the already tested contributor fixture tooling.
  const bundle = join(payload, 'Bunly.app'),
    notices = join(bundle, 'Contents/Resources/notices')
  await mkdir(notices, { recursive: true })
  const noticeInputs = [
    ['.bunly/m3/cef-license.txt', 'CEF-LICENSE.txt'],
    ['.bunly/m3/bun-license.md', 'BUN-LICENSE.md'],
    ['.bunly/m3/cef-cache/156.0.7/cef_macos_aarch64/CREDITS.html', 'CHROMIUM-CREDITS.html'],
    ['LICENSE', 'BUNLY-LICENSE'],
    ['provenance/cef-host.md', 'CEF-BINDINGS.md'],
  ] as const
  for (const [from, to] of noticeInputs) await cp(join(root, from), join(notices, to))
  const python = process.env['PYTHON'] ?? 'python3'
  const preparation = join(work, 'prepare.py')
  await writeFile(
    preparation,
    `import sys,os,shutil,subprocess\nfrom pathlib import Path\nsys.path.insert(0,${JSON.stringify(join(root, 'scripts'))})\nfrom qualify_adhoc_signing import targets\napp=Path(${JSON.stringify(bundle)})\nfor path in app.rglob('*'):\n if path.is_file() and not path.is_symlink() and path.stat().st_nlink>1:\n  tmp=path.with_name(path.name+'.independent');shutil.copyfile(path,tmp);shutil.copymode(path,tmp);os.replace(tmp,path)\nfor p in targets(app): subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(p)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nsubprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)],check=True)\n`
  )
  await command('prepare-native-copy', [python, preparation])
  await command('ephemeral-tls', [
    '/usr/bin/openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(work, 'key.pem'),
    '-out',
    join(work, 'cert.pem'),
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-days',
    '1',
  ])
  const archive = join(work, 'runtime.tar.gz')
  let requests = 0
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { key: Bun.file(join(work, 'key.pem')), cert: Bun.file(join(work, 'cert.pem')) },
    fetch(request) {
      if (new URL(request.url).pathname !== '/runtime.tar.gz')
        return new Response(null, { status: 404 })
      requests++
      return new Response(Bun.file(archive), {
        headers: {
          'content-type': 'application/gzip',
          'content-length': String(Bun.file(archive).size),
        },
      })
    },
  })
  const origin = `https://127.0.0.1:${server.port}`,
    layout = {
      executable: 'Bunly.app/Contents/MacOS/bunly_host',
      bun: 'Bunly.app/Contents/Resources/bun',
      resources: 'Bunly.app/Contents/Resources',
      helpers: [] as string[],
    }
  const scan = (
    await Bun.$`find ${join(bundle, 'Contents/Frameworks')} -type f -path '*/Contents/MacOS/*'`
      .quiet()
      .text()
  )
    .trim()
    .split('\n')
    .filter(Boolean)
  layout.helpers = scan.map((path) => 'Bunly.app/' + path.slice(bundle.length + 1))
  const manifest = await packageCefRuntime({
    directory: payload,
    output: archive,
    url: origin + '/runtime.tar.gz',
    identity,
    layout,
    notices: noticeInputs.map(([, to]) => 'Bunly.app/Contents/Resources/notices/' + to),
  })
  assert.ok(
    manifest.archive.tarBytes > 64 * 1024 * 1024,
    'Must qualify a complete CEF-sized archive'
  )
  const pair = generateKeyPairSync('ed25519'),
    bytes = Buffer.from(JSON.stringify(manifest)),
    envelope = {
      keyId: 'ephemeral-qualification',
      payload: bytes.toString('base64'),
      signature: sign(null, bytes, pair.privateKey).toString('base64'),
    }
  const trustRoots = {
      'ephemeral-qualification': pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
    cacheRoot = join(work, 'cache'),
    cert = await readFile(join(work, 'cert.pem'), 'utf8')
  const options = {
    envelope,
    trustRoots,
    expected: identity,
    cacheRoot,
    allowedOrigins: [origin],
    timeoutMs: 180000,
    fetcher: (url: string, init: RequestInit) => fetch(url, { ...init, tls: { ca: cert } }),
  }
  const first = await resolveCefRuntime(options)
  assert.equal(first.cacheHit, false)
  assert.equal(requests, 1)
  const initial = await lstat(join(first.directory, layout.executable))
  await server.stop(true)
  server = undefined
  const offline = {
    ...options,
    offline: true,
    fetcher: async () => {
      throw new Error('Offline acquisition attempted networking')
    },
  }
  const second = await resolveCefRuntime(offline)
  assert.equal(second.cacheHit, true)
  assert.equal((await lstat(join(second.directory, layout.executable))).ino, initial.ino)
  const unrelated = join(work, 'offline Unicode é launch')
  await mkdir(unrelated)
  const emptyPath = join(work, 'no-compiler-on-path')
  await mkdir(emptyPath)
  await withCefRuntime(offline, async (directory) => {
    await assert.rejects(removeCefRuntime({ ...options, timeoutMs: 50 }))
    const native = await observedCommand([join(directory, layout.executable)], {
      cwd: unrelated,
      output: join(work, 'native-offline.process.json'),
      timeoutMs: 120000,
      env: { PATH: emptyPath, BUNLY_CACHE_DIR: join(work, 'native-profile') },
    }).result
    commands.push({ name: 'native-offline', observation: native })
    acceptNativeSmoke(native)
  })
  report['manifest'] = parseCefManifest(manifest)
  report['archiveBytes'] = manifest.archive.size
  report['expandedTarBytes'] = manifest.archive.tarBytes
  report['requests'] = requests
  report['offlineCacheHit'] = second.cacheHit
  report['stableCacheInode'] = true
  report['leasedCleanupRejected'] = true
  report['compilerFreeChildPath'] = true
  const corrupt = join(second.directory, 'Bunly.app/Contents/Resources/notices/BUNLY-LICENSE')
  await writeFile(corrupt, 'tampered')
  await assert.rejects(resolveCefRuntime(offline))
  report['cachedTamperRejected'] = true
  await removeCefRuntime(options)
  await assert.rejects(resolveCefRuntime(offline))
  report['explicitCleanupVerified'] = true
  const archiveHash = createHash('sha256')
  for await (const chunk of Bun.file(archive).stream()) archiveHash.update(chunk)
  report['archiveSha256'] = archiveHash.digest('hex')
  report.passed = true
} catch (error) {
  report['failure'] = error instanceof Error ? error.message : String(error)
} finally {
  await server?.stop(true)
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ passed: report.passed, output, failure: report['failure'] }))
}
if (!report.passed) process.exitCode = 1
