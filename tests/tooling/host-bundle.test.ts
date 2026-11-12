import { afterEach, beforeAll, expect, test } from 'bun:test'
import { appendFileSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileDigest } from '../../scripts/native/artifact.ts'
import {
  defaultBundleIdentity,
  hostInfoPlist,
  hostLayout,
  MACOS_HOST_BUNDLE,
} from '../../scripts/native/build.ts'
import {
  enclosingBundle,
  entitlementsPath,
  retry,
  signBuild,
  verifyTree,
  type Command,
} from '../../scripts/native/signing.ts'
import { cleanup, temporary } from './update-fixture.ts'

afterEach(cleanup)
beforeAll(() => {
  retry.delayMs = 0
})

const HOST = `${MACOS_HOST_BUNDLE}/Contents/MacOS/bun-native-host`

test('a macOS build puts the host in an application bundle; other platforms keep it adjacent', () => {
  expect(hostLayout('darwin', 'bun-native-host')).toEqual({
    file: HOST,
    infoPlist: `${MACOS_HOST_BUNDLE}/Contents/Info.plist`,
  })
  expect(hostLayout('linux', 'bun-native-host')).toEqual({ file: 'bun-native-host' })
  expect(hostLayout('win32', 'bun-native-host.exe')).toEqual({ file: 'bun-native-host.exe' })
})

test('the host Info.plist names the identifier, executable and escaped name', () => {
  const plist = hostInfoPlist('dev.bun-native.app.notes', 'Notes & <Co>', 'bun-native-host')
  expect(plist).toContain(
    '<key>CFBundleIdentifier</key>\n  <string>dev.bun-native.app.notes</string>'
  )
  expect(plist).toContain('<key>CFBundleExecutable</key>\n  <string>bun-native-host</string>')
  expect(plist).toContain('<string>Notes &amp; &lt;Co&gt;</string>')
  expect(plist).toContain('<key>CFBundlePackageType</key>\n  <string>APPL</string>')
  expect(plist).toContain('<key>NSHighResolutionCapable</key>\n  <true/>')
  for (const identifier of ['', 'notes', 'dev..notes', 'dev.notes app', 'dev.<x>'])
    expect(() => hostInfoPlist(identifier, 'Notes', 'bun-native-host')).toThrow(
      'is not reverse-DNS text'
    )
})

test('the default identity comes from the project package name', async () => {
  const directory = await temporary()
  const project = { directory, framework: 'solid' as const, entry: join(directory, 'main.tsx') }
  expect(await defaultBundleIdentity(project)).toEqual({
    identifier: 'dev.bun-native.app.application',
    name: 'application',
  })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@acme/My Notes!' }))
  const identity = await defaultBundleIdentity(project)
  expect(identity).toEqual({
    identifier: 'dev.bun-native.app.acme-My-Notes',
    name: '@acme/My Notes!',
  })
  expect(() => hostInfoPlist(identity.identifier, identity.name, 'bun-native-host')).not.toThrow()
})

test('only the main executable of an application bundle has an enclosing bundle', () => {
  expect(enclosingBundle(`/r/${HOST}`)).toBe(`/r/${MACOS_HOST_BUNDLE}`)
  expect(enclosingBundle('/r/bun-native-host')).toBeUndefined()
  expect(enclosingBundle(`/r/${MACOS_HOST_BUNDLE}/Contents/Resources/x`)).toBeUndefined()
  expect(enclosingBundle(`/r/${MACOS_HOST_BUNDLE}/Contents/MacOS/a/b`)).toBeUndefined()
})

const machO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01])

async function bundledBuild(host: (path: string) => Promise<void>) {
  const build = await temporary()
  await mkdir(join(build, MACOS_HOST_BUNDLE, 'Contents/MacOS'), { recursive: true })
  await writeFile(
    join(build, MACOS_HOST_BUNDLE, 'Contents/Info.plist'),
    hostInfoPlist('dev.bun-native.app.test', 'Test', 'bun-native-host')
  )
  await host(join(build, 'application'))
  await host(join(build, HOST))
  const manifest = {
    target: { os: 'darwin', architecture: process.arch },
    application: { file: 'application', ...(await fileDigest(join(build, 'application'))) },
    host: { file: HOST, ...(await fileDigest(join(build, HOST))) },
    verification: { signing: 'unsigned' },
  }
  await writeFile(join(build, 'manifest.json'), JSON.stringify(manifest))
  return build
}

test('a bundled macOS host is signed and verified as its bundle', async () => {
  const build = await bundledBuild((path) =>
    writeFile(path, Buffer.concat([machO, Buffer.from(path)]))
  )
  const calls: string[][] = []
  const runner = (command: string[]): Command => {
    calls.push(command)
    const path = command.at(-1)!
    if (command[0] === 'codesign' && command[1] === '--force') {
      appendFileSync(
        path.endsWith('.app') ? join(path, 'Contents/MacOS/bun-native-host') : path,
        'SIG'
      )
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (command[1] === '--display')
      return {
        exitCode: 0,
        stdout: '',
        stderr: 'CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+1 location=embedded',
      }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const summary = await signBuild(
    build,
    { platform: 'darwin', identity: '-', entitlements: entitlementsPath, timestamp: false },
    runner
  )
  const signed = calls
    .filter((command) => command[1] === '--force')
    .map((command) => command.at(-1))
  expect(signed).toEqual([join(build, MACOS_HOST_BUNDLE), join(build, 'application')])
  // The host gets no entitlements; it is verified through its bundle.
  const hostSign = calls.find((command) => command.at(-1) === join(build, MACOS_HOST_BUNDLE))!
  expect(hostSign).not.toContain('--entitlements')
  expect(calls).toContainEqual([
    'codesign',
    '--verify',
    '--strict',
    '--verbose=2',
    join(build, MACOS_HOST_BUNDLE),
  ])
  expect(summary.files.map((record) => record.file)).toEqual([HOST, 'application'])
  const after = JSON.parse(readFileSync(join(build, 'manifest.json'), 'utf8'))
  expect(after.host).toEqual({ file: HOST, ...(await fileDigest(join(build, HOST))) })
  calls.length = 0
  const verified = await verifyTree(build, 'darwin', runner)
  expect(verified.map((entry) => entry.file)).toEqual([HOST, 'application'])
  expect(
    calls.filter((command) => command[1] === '--verify').map((command) => command.at(-1))
  ).toEqual([join(build, MACOS_HOST_BUNDLE), join(build, 'application')])
})

// The real codesign path with an ad-hoc identity (hosted macOS CI runs it in `bun test
// tests`): the bundle's Info.plist is sealed and its identifier is the signing identifier.
test.if(process.platform === 'darwin')(
  'codesign seals the host bundle and its identifier',
  async () => {
    const build = await bundledBuild((path) => copyFile(process.execPath, path))
    await signBuild(build, {
      platform: 'darwin',
      identity: '-',
      entitlements: entitlementsPath,
      timestamp: false,
    })
    const verified = await verifyTree(build, 'darwin')
    expect(verified.map((entry) => [entry.file, entry.hardenedRuntime])).toEqual([
      [HOST, true],
      ['application', true],
    ])
    const shown = Bun.spawnSync(
      ['codesign', '--display', '--verbose=2', join(build, MACOS_HOST_BUNDLE)],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    const text = shown.stdout.toString() + shown.stderr.toString()
    expect(text).toContain('Identifier=dev.bun-native.app.test')
    expect(text).toMatch(/Info\.plist entries=\d+/)
  },
  120_000
)
