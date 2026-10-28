import { generateKeyPairSync, sign } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createTar, sha256, resolveArtifact } from '../packages/artifacts/src/index.ts'
import type { ArtifactIdentity, ArtifactManifest } from '../packages/artifacts/src/index.ts'
import { loadNative } from './probes/native-api.ts'
import { nativeReleaseDirectory } from './cargo-config.ts'
const root = resolve(import.meta.dir, '..')
const target = `${process.platform}-${process.arch}`
if (!['linux-x64', 'darwin-arm64', 'win32-x64'].includes(target))
  throw new Error(`Probe target ${target} is not supported`)
const out = join(root, '.bunly/artifacts', target)
const symbols = join(out, 'symbols')
await mkdir(symbols, { recursive: true })
const lib =
  process.platform === 'win32'
    ? 'bunly_host_probe.dll'
    : process.platform === 'darwin'
      ? 'libbunly_host_probe.dylib'
      : 'libbunly_host_probe.so'
const native = await nativeReleaseDirectory(
  root,
  process.platform === 'win32' ? [lib, 'bunly_host_probe.pdb'] : [lib]
)
const stage = join(out, 'probe.node')
await copyFile(join(native, lib), stage)
if (process.platform === 'linux') {
  execFileSync('objcopy', ['--only-keep-debug', stage, join(symbols, 'probe.debug')])
  execFileSync('objcopy', ['--strip-debug', stage])
} else if (process.platform === 'darwin') {
  execFileSync('dsymutil', [stage, '-o', join(symbols, 'probe.dSYM')])
  execFileSync('strip', ['-S', stage])
} else await copyFile(join(native, 'bunly_host_probe.pdb'), join(symbols, 'probe.pdb'))
const bytes = await readFile(stage)
const archive = createTar([{ path: 'probe.node', bytes }])
const identity: ArtifactIdentity = {
  kind: 'host-probe',
  version: '0.1.0-dev.0',
  abi: 1,
  backend: 'none',
  target: target as ArtifactIdentity['target'],
  bun: process.versions['bun']!,
  nativeToolchain: 'rust-1.85.1',
  cef: null,
}
const manifest: ArtifactManifest = {
  schema: 1,
  identity,
  archive: {
    url: 'https://ci-fixture.invalid/probe.tar',
    format: 'ustar',
    size: archive.length,
    sha256: sha256(archive),
  },
  files: [{ path: 'probe.node', size: bytes.length, sha256: sha256(bytes), executable: false }],
}
// Ephemeral CI fixture key. No private key is written or published; this is not a production trust root.
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const payload = Buffer.from(JSON.stringify(manifest))
const trustRoots = {
  'ephemeral-ci-fixture': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}
const envelope = {
  keyId: 'ephemeral-ci-fixture',
  payload: payload.toString('base64'),
  signature: sign(null, payload, privateKey).toString('base64'),
}
await writeFile(join(out, 'probe.tar'), archive)
await writeFile(join(out, 'manifest.json'), JSON.stringify(envelope, null, 2) + '\n')
await writeFile(join(out, 'fixture-trust.json'), JSON.stringify(trustRoots, null, 2) + '\n')
await writeFile(
  join(out, 'sbom-input.json'),
  JSON.stringify(
    {
      schema: 1,
      artifact: identity,
      components: [
        { name: 'bunly-host-probe', version: '0.1.0', license: 'MIT' },
        { name: 'Rust standard library', version: '1.85.1', license: 'MIT OR Apache-2.0' },
      ],
      notBundled: ['Bun', 'CEF'],
      completeProductionSbom: false,
      commit: process.env['GITHUB_SHA'] ?? 'local-uncommitted',
    },
    null,
    2
  ) + '\n'
)
let downloads = 0
const opts = {
  envelope,
  trustRoots,
  expected: identity,
  cacheRoot: join(root, '.bunly/consumer-cache', target),
  allowedOrigins: ['https://ci-fixture.invalid'],
  fetcher: async () => {
    downloads++
    return new Response(archive)
  },
}
const first = await resolveArtifact(opts)
const second = await resolveArtifact({ ...opts, offline: true })
const api = loadNative(join(second.directory, 'probe.node'), 'ffi')
if (api.abi() !== 1 || api.add(20, 22) !== 42) throw new Error('Packaged probe did not load')
api.close()
const report = {
  schema: 1,
  target,
  kind: 'native-probe-not-desktop-runtime',
  archiveBytes: archive.length,
  installedBytes: bytes.length,
  firstCacheHit: first.cacheHit,
  offlineCacheHit: second.cacheHit,
  downloads,
  loadedNativeArtifact: true,
  ephemeralTestSigning: true,
  productionTrust: false,
}
await writeFile(join(out, 'consumer-result.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
await rm(stage)
