import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import toolchain from '../../toolchain.json'
import { fileDigest } from '../../scripts/native/artifact.ts'
import { createBundle } from '../../scripts/native/installer.ts'
import { notarize, notaryCredentials } from '../../scripts/native/notarize.ts'
import {
  entitlementsPath,
  nativeKind,
  parseCodesignDisplay,
  parseSigntoolVerify,
  retry,
  signBuild,
  signBundle,
  verifyTree,
  type Command,
  type SigningIdentity,
} from '../../scripts/native/signing.ts'
import { createUpdateManifest } from '../../scripts/native/update-manifest.ts'
import { cleanup, requirements, temporary } from './update-fixture.ts'

afterEach(cleanup)
beforeAll(() => {
  retry.delayMs = 0
})

const machO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01])
function pe(): Buffer {
  const bytes = Buffer.alloc(256)
  bytes.write('MZ', 0, 'latin1')
  bytes.writeUInt32LE(128, 60)
  bytes.write('PE\0\0', 128, 'latin1')
  return bytes
}

/** A synthetic `native build` output for another OS, with native-looking executables. */
async function foreignBuild(os: 'darwin' | 'win32', extra: Record<string, Buffer> = {}) {
  const directory = await temporary()
  const suffix = os === 'win32' ? '.exe' : ''
  const header = os === 'win32' ? pe() : machO
  const application = `application${suffix}`
  const host = `bun-native-host${suffix}`
  await writeFile(join(directory, application), Buffer.concat([header, Buffer.from('app')]))
  await writeFile(join(directory, host), Buffer.concat([header, Buffer.from('host')]))
  await mkdir(join(directory, 'development'))
  await writeFile(join(directory, 'development/application.js'), 'console.log(1)\n')
  for (const [path, data] of Object.entries(extra)) await writeFile(join(directory, path), data)
  const manifest = {
    schemaVersion: 1,
    target: { os, architecture: process.arch },
    toolchain: { bun: { revision: toolchain.bun.revision } },
    application: { file: application, ...(await fileDigest(join(directory, application))) },
    host: { file: host, ...(await fileDigest(join(directory, host))) },
    reproducibility: {
      deterministic: [application, host, 'development/application.js', 'manifest.json'],
      diagnostics: ['build-metrics.json'],
    },
    verification: { aotCompiledProgram: 'passed', signing: 'unsigned' },
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return directory
}

const codesignDisplay = [
  'Executable=/tmp/x',
  'Identifier=application',
  'Format=Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=1000 flags=0x10000(runtime) hashes=20+7 location=embedded',
  'Signature size=4000',
  'Authority=Developer ID Application: Example (TEAM123456)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=Nov 11, 2026 at 10:00:00',
  'TeamIdentifier=TEAM123456',
].join('\n')

const signtoolVerify = [
  'Verifying: C:\\work\\application.exe',
  '',
  'Signature Index: 0 (Primary Signature)',
  'Hash of file (sha256): 0F00',
  '',
  'Signing Certificate Chain:',
  '    Issued to: Example Root',
  '    Issued by: Example Root',
  '        Issued to: Example Code Signing CA',
  '        Issued by: Example Root',
  '            Issued to: Example Publisher',
  '            Issued by: Example Code Signing CA',
  '',
  'The signature is timestamped: Wed Nov 11 10:00:00 2026',
  'Timestamp Verified by:',
  '    Issued to: Example TSA Root',
  '',
  'Successfully verified: C:\\work\\application.exe',
].join('\r\n')

/**
 * Stands in for codesign and signtool: signing appends bytes like a real signature, the
 * display and verify commands describe a valid timestamped signature, and every command
 * is recorded. `failures` makes the first N signing attempts fail.
 */
function fakeTools(failures = 0) {
  const calls: string[][] = []
  let failed = 0
  const runner = (command: string[]): Command => {
    calls.push(command)
    const tool = command[0]!
    const path = command.at(-1)!
    if ((tool === 'codesign' && command[1] === '--force') || command[1] === 'sign') {
      if (failed < failures) {
        failed++
        return { exitCode: 1, stdout: '', stderr: 'The timestamp service is not available.' }
      }
      appendFileSync(path, 'SIGNATURE')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (tool === 'codesign' && command[1] === '--display')
      return { exitCode: 0, stdout: '', stderr: codesignDisplay }
    if (command[1] === 'verify') return { exitCode: 0, stdout: signtoolVerify, stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { calls, runner }
}

const darwin = (keychain?: string): SigningIdentity => ({
  platform: 'darwin',
  identity: '0123456789ABCDEF0123456789ABCDEF01234567',
  ...(keychain ? { keychain } : {}),
  entitlements: entitlementsPath,
  timestamp: true,
})
const win32: SigningIdentity = {
  platform: 'win32',
  signtool: 'C:\\SDK\\signtool.exe',
  certificate: { thumbprint: 'ABCDEF' },
  timestampUrl: 'http://timestamp.example',
}

describe('native executable detection', () => {
  test('recognises Mach-O, PE and ELF headers and nothing else', async () => {
    const directory = await temporary()
    const cases: [string, Buffer, string | undefined][] = [
      ['mach', machO, 'mach-o'],
      ['fat', Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]), 'mach-o'],
      ['pe.exe', pe(), 'pe'],
      ['elf', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), 'elf'],
      ['dos', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]), undefined],
      ['script.sh', Buffer.from('#!/bin/sh\necho\n'), undefined],
      ['empty', Buffer.alloc(0), undefined],
    ]
    for (const [name, data, kind] of cases) {
      await writeFile(join(directory, name), data)
      expect([name, await nativeKind(join(directory, name))]).toEqual([name, kind])
    }
  })
})

describe('signing a native build output', () => {
  test('macOS: hardened runtime, timestamp and entitlements for Bun only; manifest rewritten', async () => {
    const build = await foreignBuild('darwin')
    const before = JSON.parse(await readFile(join(build, 'manifest.json'), 'utf8'))
    const { calls, runner } = fakeTools()
    const summary = await signBuild(build, darwin('/tmp/signing.keychain-db'), runner)
    const signs = calls.filter((call) => call[1] === '--force')
    expect(signs).toEqual([
      [
        'codesign',
        '--force',
        '--sign',
        '0123456789ABCDEF0123456789ABCDEF01234567',
        '--options',
        'runtime',
        '--timestamp',
        '--keychain',
        '/tmp/signing.keychain-db',
        '--entitlements',
        entitlementsPath,
        join(build, 'application'),
      ],
      [
        'codesign',
        '--force',
        '--sign',
        '0123456789ABCDEF0123456789ABCDEF01234567',
        '--options',
        'runtime',
        '--timestamp',
        '--keychain',
        '/tmp/signing.keychain-db',
        join(build, 'bun-native-host'),
      ],
    ])
    for (const file of ['application', 'bun-native-host'])
      expect(calls).toContainEqual([
        'codesign',
        '--verify',
        '--strict',
        '--verbose=2',
        join(build, file),
      ])
    expect(summary).toMatchObject({
      kind: 'apple-codesign',
      identity: 'Developer ID Application: Example (TEAM123456)',
      teamIdentifier: 'TEAM123456',
      timestamped: true,
    })
    const after = JSON.parse(await readFile(join(build, 'manifest.json'), 'utf8'))
    for (const part of ['application', 'host']) {
      const file = before[part].file
      expect(after[part]).toEqual({ file, ...(await fileDigest(join(build, file))) })
      const record = summary.files.find((entry) => entry.file === file)!
      expect(record.unsigned).toEqual({ bytes: before[part].bytes, sha256: before[part].sha256 })
      expect(record.signed.sha256).not.toBe(before[part].sha256)
      expect(record.verification).toMatchObject({ file, hardenedRuntime: true })
    }
    expect(after.reproducibility).toEqual({
      deterministic: ['development/application.js'],
      diagnostics: ['build-metrics.json'],
      signed: ['application', 'bun-native-host', 'manifest.json'],
    })
    expect(after.verification).toEqual({ aotCompiledProgram: 'passed', signing: summary })
    // The update manifest accepts the signed build: its build-manifest cross-check passes.
    const update = await createUpdateManifest(build, {
      product: 'dev.bun-native.example',
      version: '1.0.0',
      sequence: 1,
      trust: 'unsigned-experimental',
      protocol: requirements.protocol,
    })
    expect(update.files['application']).toEqual({
      bytes: after.application.bytes,
      sha256: after.application.sha256,
      executable: true,
    })
    await expect(signBuild(build, darwin(), runner)).rejects.toThrow('already signed')
  })

  test('Windows: SHA-256 Authenticode with an RFC 3161 timestamp, retried', async () => {
    const build = await foreignBuild('win32')
    const { calls, runner } = fakeTools(2)
    const summary = await signBuild(build, win32, runner)
    const signs = calls.filter((call) => call[1] === 'sign')
    // Two failed attempts for the first file, then one per file.
    expect(signs).toHaveLength(4)
    expect(signs[0]).toEqual([
      'C:\\SDK\\signtool.exe',
      'sign',
      '/v',
      '/fd',
      'sha256',
      '/sha1',
      'ABCDEF',
      '/s',
      'My',
      '/tr',
      'http://timestamp.example',
      '/td',
      'sha256',
      join(build, 'application.exe'),
    ])
    expect(calls).toContainEqual([
      'C:\\SDK\\signtool.exe',
      'verify',
      '/pa',
      '/v',
      join(build, 'bun-native-host.exe'),
    ])
    expect(summary).toMatchObject({
      kind: 'windows-authenticode',
      identity: 'Example Publisher',
      timestamped: true,
    })
  })

  test('a timestamp server that keeps failing fails the signing', async () => {
    const build = await foreignBuild('win32')
    const { runner } = fakeTools(3)
    await expect(signBuild(build, win32, runner)).rejects.toThrow('Code signing failed (1)')
    // Nothing was rewritten.
    expect(
      JSON.parse(await readFile(join(build, 'manifest.json'), 'utf8')).verification.signing
    ).toBe('unsigned')
  })

  test('a signing service dlib replaces the certificate store', async () => {
    const build = await foreignBuild('win32')
    const { calls, runner } = fakeTools()
    await signBuild(
      build,
      { ...win32, certificate: { dlib: 'C:\\dlib.dll', metadata: 'C:\\metadata.json' } },
      runner
    )
    expect(calls[0]).toContain('/dlib')
    expect(calls[0]).toContain('C:\\metadata.json')
    expect(calls[0]).not.toContain('/sha1')
  })

  test('refuses builds it cannot sign completely and correctly', async () => {
    const { runner } = fakeTools()
    await expect(signBuild(await foreignBuild('win32'), darwin(), runner)).rejects.toThrow(
      'A win32 build cannot be signed with darwin tools'
    )
    const modified = await foreignBuild('darwin')
    await appendFile(join(modified, 'application'), 'changed')
    await expect(signBuild(modified, darwin(), runner)).rejects.toThrow(
      'application does not match the build manifest'
    )
    const mixed = await foreignBuild('darwin', { 'helper.exe': pe() })
    await expect(signBuild(mixed, darwin(), runner)).rejects.toThrow(
      'helper.exe is a pe executable, not a darwin one'
    )
    if (process.platform !== 'win32') {
      const linked = await foreignBuild('darwin')
      await symlink(join(linked, 'application'), join(linked, 'alias'))
      await expect(signBuild(linked, darwin(), runner)).rejects.toThrow('symbolic link: alias')
    }
    const invalid = await foreignBuild('darwin')
    const failing = (command: string[]): Command =>
      command[1] === '--verify'
        ? { exitCode: 3, stdout: '', stderr: 'invalid signature' }
        : runner(command)
    await expect(signBuild(invalid, darwin(), failing)).rejects.toThrow(
      'Signature verification failed'
    )
    const plain = await foreignBuild('darwin')
    const noRuntime = (command: string[]): Command =>
      command[1] === '--display'
        ? { exitCode: 0, stdout: '', stderr: codesignDisplay.replace('(runtime)', '(none)') }
        : runner(command)
    await expect(signBuild(plain, darwin(), noRuntime)).rejects.toThrow('hardened runtime')
  })
})

describe('signing a self-contained bundle', () => {
  test('signs the updater and launcher, never the payload, and records it', async () => {
    const build = await foreignBuild('darwin')
    const { runner } = fakeTools()
    await signBuild(build, darwin(), runner)
    const work = await temporary()
    const manifestPath = join(work, 'update.json')
    const manifest = await createUpdateManifest(build, {
      product: 'dev.bun-native.example',
      version: '1.0.0',
      sequence: 1,
      trust: 'unsigned-experimental',
      protocol: requirements.protocol,
    })
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    const { directory } = await createBundle(build, manifestPath, work)
    const readme = await readFile(join(directory, 'README.txt'), 'utf8')
    expect(readme).toContain(
      'The payload executables are OS code-signed by Developer ID Application: Example (TEAM123456)'
    )
    expect(readme).not.toContain('NOT present')
    await expect(signBundle(directory, darwin(), runner)).rejects.toThrow(
      'no bun-native-update; use --self-contained'
    )
    for (const tool of ['bun-native-update', 'launcher'])
      await writeFile(join(directory, tool), Buffer.concat([machO, Buffer.from(tool)]))
    const payload = await fileDigest(join(directory, 'payload/application'))
    const tools = fakeTools()
    const summary = await signBundle(directory, darwin(), tools.runner)
    expect(summary.files.map((file) => file.file)).toEqual(['bun-native-update', 'launcher'])
    expect(
      tools.calls
        .filter((call) => call[1] === '--force')
        .every((call) => call.includes('--entitlements'))
    ).toBe(true)
    expect(await fileDigest(join(directory, 'payload/application'))).toEqual(payload)
    expect(JSON.parse(await readFile(join(directory, 'signing.json'), 'utf8'))).toEqual(summary)
    expect(await readFile(join(directory, 'README.txt'), 'utf8')).toEndWith(
      'The bundled updater and launcher are code-signed by Developer ID Application: Example (TEAM123456); see signing.json.\n'
    )
    await appendFile(join(directory, 'payload/development/application.js'), '//')
    await expect(signBundle(directory, darwin(), tools.runner)).rejects.toThrow(
      'payload/development/application.js does not match update.json'
    )
  })
})

describe('parsing tool output', () => {
  test('codesign display', () => {
    expect(parseCodesignDisplay(codesignDisplay)).toEqual({
      authority: [
        'Developer ID Application: Example (TEAM123456)',
        'Developer ID Certification Authority',
        'Apple Root CA',
      ],
      teamIdentifier: 'TEAM123456',
      timestamp: 'Nov 11, 2026 at 10:00:00',
      hardenedRuntime: true,
    })
    expect(
      parseCodesignDisplay(
        'CodeDirectory v=20400 size=1 flags=0x10002(adhoc,runtime) hashes=1+0\nSignature=adhoc\nTeamIdentifier=not set'
      )
    ).toEqual({ authority: [], hardenedRuntime: true })
  })

  test('signtool verify, leaf first', () => {
    expect(parseSigntoolVerify(signtoolVerify)).toEqual({
      authority: ['Example Publisher', 'Example Code Signing CA', 'Example Root'],
      timestamp: 'Wed Nov 11 10:00:00 2026',
    })
    expect(parseSigntoolVerify('SignTool Error: No signature found.')).toEqual({ authority: [] })
  })
})

describe('notarization', () => {
  const apiKey = {
    APPLE_NOTARY_KEY_ID: 'KEY123',
    APPLE_NOTARY_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
    APPLE_NOTARY_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
  }
  const appleId = {
    APPLE_ID: 'release@example.com',
    APPLE_TEAM_ID: 'TEAM123456',
    APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
  }

  test('credentials: none, either complete set, and refusal of a partial set', () => {
    const none = notaryCredentials({})
    expect(none.kind).toBe('none')
    expect(none.kind === 'none' && none.reason).toContain('APPLE_NOTARY_KEY_ID')
    expect(notaryCredentials(apiKey).kind).toBe('api-key')
    expect(notaryCredentials(appleId).kind).toBe('apple-id')
    expect(notaryCredentials({ ...appleId, ...apiKey }).kind).toBe('api-key')
    expect(() => notaryCredentials({ APPLE_ID: 'x', APPLE_TEAM_ID: 'y' })).toThrow(
      'set APPLE_APP_SPECIFIC_PASSWORD or unset APPLE_ID, APPLE_TEAM_ID'
    )
    expect(() => notaryCredentials({ ...appleId, APPLE_NOTARY_KEY_ID: 'k' })).toThrow(
      'Incomplete notarization credentials'
    )
  })

  test('skips with the reason when nothing is configured', async () => {
    const calls: string[][] = []
    const record = await notarize('/x/App.dmg', notaryCredentials({}), (command) => {
      calls.push(command)
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    expect(record).toMatchObject({ status: 'skipped', file: '/x/App.dmg' })
    expect(calls).toEqual([])
  })

  test('submits with an API key, waits, staples and requires Gatekeeper acceptance', async () => {
    const calls: string[][] = []
    let keyWhileRunning = ''
    const record = await notarize('/x/App.dmg', notaryCredentials(apiKey), (command) => {
      calls.push(command)
      if (command[1] === 'notarytool') {
        const key = command[command.indexOf('--key') + 1]!
        keyWhileRunning = readFileSync(key, 'utf8')
        expect(key).toEndWith('AuthKey_KEY123.p8')
        return { exitCode: 0, stdout: '{"id":"sub-1","status":"Accepted"}', stderr: '' }
      }
      if (command[0] === 'spctl')
        return {
          exitCode: 0,
          stdout: '',
          stderr: '/x/App.dmg: accepted\nsource=Notarized Developer ID\n',
        }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    expect(keyWhileRunning).toBe(apiKey.APPLE_NOTARY_PRIVATE_KEY)
    const key = calls[0]![calls[0]!.indexOf('--key') + 1]!
    expect(existsSync(key)).toBe(false)
    expect(calls.map((call) => call.slice(0, 3))).toEqual([
      ['xcrun', 'notarytool', 'submit'],
      ['xcrun', 'stapler', 'staple'],
      ['xcrun', 'stapler', 'validate'],
      ['spctl', '--assess', '--type'],
    ])
    expect(calls[0]).toContain('--wait')
    expect(record).toMatchObject({ status: 'accepted', submission: 'sub-1', stapled: true })
  })

  test('a rejected submission fetches the log and fails; Gatekeeper must name notarization', async () => {
    const calls: string[][] = []
    await expect(
      notarize('/x/App.dmg', notaryCredentials(appleId), (command) => {
        calls.push(command)
        if (command[2] === 'submit')
          return { exitCode: 0, stdout: '{"id":"sub-2","status":"Invalid"}', stderr: '' }
        return {
          exitCode: 0,
          stdout: 'The binary is not signed with a valid Developer ID',
          stderr: '',
        }
      })
    ).rejects.toThrow('Notarization sub-2 ended as Invalid\nThe binary is not signed')
    expect(calls[0]).toEqual(
      expect.arrayContaining(['--apple-id', 'release@example.com', '--team-id', 'TEAM123456'])
    )
    expect(calls[1]!.slice(0, 4)).toEqual(['xcrun', 'notarytool', 'log', 'sub-2'])
    await expect(
      notarize('/x/App.dmg', notaryCredentials(appleId), (command) =>
        command[2] === 'submit'
          ? { exitCode: 0, stdout: '{"id":"s","status":"Accepted"}', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: 'accepted\nsource=Developer ID' }
      )
    ).rejects.toThrow('Gatekeeper did not accept')
    await expect(
      notarize('/x/application', notaryCredentials(appleId), () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
      }))
    ).rejects.toThrow('Notarize a signed .dmg or .pkg')
  })
})

// The real codesign path, with an ad-hoc identity that every Mac has (hosted macOS CI runs
// it in `bun test tests`): hardened runtime, the shipped entitlements and strict verification.
test.if(process.platform === 'darwin')(
  'codesign signs and strictly verifies Mach-O executables with the shipped entitlements',
  async () => {
    const build = await temporary()
    for (const file of ['application', 'bun-native-host'])
      await copyFile(process.execPath, join(build, file))
    const manifest = {
      target: { os: 'darwin', architecture: process.arch },
      application: { file: 'application', ...(await fileDigest(join(build, 'application'))) },
      host: { file: 'bun-native-host', ...(await fileDigest(join(build, 'bun-native-host'))) },
      verification: { signing: 'unsigned' },
    }
    await writeFile(join(build, 'manifest.json'), JSON.stringify(manifest))
    const summary = await signBuild(build, {
      platform: 'darwin',
      identity: '-',
      entitlements: entitlementsPath,
      timestamp: false,
    })
    expect(summary).toMatchObject({ kind: 'apple-codesign', identity: 'ad-hoc' })
    const verified = await verifyTree(build, 'darwin')
    expect(verified.map((entry) => [entry.file, entry.hardenedRuntime])).toEqual([
      ['application', true],
      ['bun-native-host', true],
    ])
    const entitlements = Bun.spawnSync([
      'codesign',
      '--display',
      '--entitlements',
      '-',
      '--xml',
      join(build, 'application'),
    ])
    expect(entitlements.stdout.toString()).toContain('com.apple.security.cs.allow-jit')
    // The signed copy of Bun still runs under the hardened runtime.
    const ran = Bun.spawnSync([join(build, 'application'), '-e', 'console.log(6 * 7)'])
    expect(ran.stdout.toString().trim()).toBe('42')
  },
  120_000
)

// The throwaway identity that hosted macOS CI imports into a temporary keychain. The
// keychain part needs macOS; certificate generation runs wherever OpenSSL does.
test.if(process.platform !== 'win32' && Bun.which('openssl') !== null)(
  'the throwaway macOS identity is a self-signed code-signing certificate in a 3DES PKCS#12',
  async () => {
    const work = join(await temporary(), 'identity')
    const script = join(import.meta.dir, '../../scripts/signing/macos-identity.sh')
    const generated = Bun.spawnSync(['bash', script, 'generate', work], { stderr: 'pipe' })
    expect({ code: generated.exitCode, err: generated.stderr.toString() }).toEqual({
      code: 0,
      err: '',
    })
    const certificate = Bun.spawnSync(
      ['openssl', 'x509', '-in', join(work, 'throwaway.pem'), '-noout', '-text'],
      { stdout: 'pipe' }
    ).stdout.toString()
    expect(certificate).toMatch(/Subject: CN ?= ?Bun Native CI Throwaway Code Signing/)
    expect(certificate).toMatch(/Extended Key Usage: critical\s+Code Signing/)
    expect(certificate).toMatch(/Key Usage: critical\s+Digital Signature/)
    expect(certificate).toMatch(/Basic Constraints: critical\s+CA:FALSE/)
    const bundle = Bun.spawnSync(
      [
        'openssl',
        'pkcs12',
        '-info',
        '-noout',
        '-in',
        join(work, 'identity.p12'),
        '-passin',
        `file:${join(work, 'identity.password')}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    const info = bundle.stdout.toString() + bundle.stderr.toString()
    expect(bundle.exitCode).toBe(0)
    // OpenSSL 3 names the MAC; LibreSSL (/usr/bin/openssl on macOS) only reports it verified.
    expect(info).toMatch(/MAC: sha1|MAC verified OK/)
    expect(info).toMatch(/pbeWithSHA1And3-KeyTripleDES-CBC/i)
    expect(existsSync(join(work, 'throwaway.key'))).toBe(false)
  }
)
