import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib'
import toolchain from '../../toolchain.json'
import { fileDigest } from '../../scripts/native/artifact.ts'
import { createBundle } from '../../scripts/native/installer.ts'
import {
  createInstaller,
  INSTALLER_COMPRESSION_LEVEL,
  zipArchive,
} from '../../scripts/native/installer-image.ts'
import { createUpdateManifest, signUpdate } from '../../scripts/native/update-manifest.ts'
import { cleanup, keys, repository, requirements, temporary } from './update-fixture.ts'

afterEach(cleanup)

const windows = process.platform === 'win32'
const exe = windows ? '.exe' : ''

/** A synthetic build output and bundle for any target OS, with stand-in tools. */
async function bundleFor(
  os: 'linux' | 'darwin' | 'win32',
  trust: 'ed25519' | 'unsigned-experimental' = 'ed25519',
  tools = true,
  application: string | Uint8Array = 'application\n'
) {
  const build = await temporary()
  const suffix = os === 'win32' ? '.exe' : ''
  await writeFile(join(build, `application${suffix}`), application, { mode: 0o755 })
  await writeFile(join(build, `bun-native-host${suffix}`), 'host\n', { mode: 0o755 })
  await mkdir(join(build, 'development'))
  await writeFile(join(build, 'development/application.js'), 'console.log(1)\n')
  await writeFile(
    join(build, 'manifest.json'),
    JSON.stringify({
      target: { os, architecture: process.arch },
      toolchain: { bun: { revision: toolchain.bun.revision } },
      application: {
        file: `application${suffix}`,
        ...(await fileDigest(join(build, `application${suffix}`))),
      },
      host: {
        file: `bun-native-host${suffix}`,
        ...(await fileDigest(join(build, `bun-native-host${suffix}`))),
      },
    })
  )
  const work = await temporary()
  const manifest = await createUpdateManifest(build, {
    product: 'dev.bun-native.example',
    version: '1.2.3',
    sequence: 4,
    trust,
    protocol: requirements.protocol,
  })
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(work, 'update.json'), bytes)
  if (trust === 'ed25519')
    await writeFile(join(work, 'update.json.sig'), signUpdate(bytes, keys.privateKey))
  const { directory } = await createBundle(build, join(work, 'update.json'), work)
  if (tools) {
    for (const tool of ['bun-native-update', 'launcher'])
      await writeFile(join(directory, `${tool}${suffix}`), tool, { mode: 0o755 })
    if (trust === 'ed25519') await writeFile(join(directory, 'keys.json'), '{}')
  }
  return { directory, out: await temporary() }
}

/** Minimal readers for the two archive formats, independent of the writers. */
function untar(archive: Buffer): Map<string, { data: string; mode: number }> {
  const tar = gunzipSync(archive)
  const members = new Map<string, { data: string; mode: number }>()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.toString('latin1', 0, 100).replace(/\0.*$/s, '')
    const mode = parseInt(header.toString('latin1', 100, 107), 8)
    const size = parseInt(header.toString('latin1', 124, 135), 8)
    members.set(name, { data: tar.toString('utf8', offset + 512, offset + 512 + size), mode })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return members
}

function unzip(archive: Buffer): Map<string, { data: string; mode: number }> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  const members = new Map<string, { data: string; mode: number }>()
  for (let index = 0; index < count; index++) {
    expect(archive.readUInt32LE(offset)).toBe(0x02014b50)
    const nameLength = archive.readUInt16LE(offset + 28)
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength)
    const local = archive.readUInt32LE(offset + 42)
    const compressed = archive.readUInt32LE(local + 18)
    const localName = archive.readUInt16LE(local + 26)
    const data = inflateRawSync(
      archive.subarray(local + 30 + localName, local + 30 + localName + compressed)
    )
    expect(crc32(data)).toBe(archive.readUInt32LE(local + 14))
    members.set(name, {
      data: data.toString('utf8'),
      mode: archive.readUInt32LE(offset + 38) >>> 16,
    })
    offset += 46 + nameLength
  }
  return members
}

describe('installer images', () => {
  test('tar.gz: the unchanged bundle and an install script, byte-reproducible', async () => {
    const { directory, out } = await bundleFor('linux')
    const record = await createInstaller(directory, out, { format: 'tar.gz', name: 'Example App' })
    const name = 'dev.bun-native.example-1.2.3-linux-' + process.arch
    expect(record).toMatchObject({
      file: join(out, `${name}.tar.gz`),
      format: 'tar.gz',
      product: 'dev.bun-native.example',
      version: '1.2.3',
      trust: 'ed25519',
    })
    const members = untar(await readFile(record.file))
    expect([...members.keys()].sort()).toEqual(
      [
        'README.txt',
        'bun-native-update',
        'install.sh',
        'keys.json',
        'launcher',
        'payload/application',
        'payload/bun-native-host',
        'payload/development/application.js',
        'payload/manifest.json',
        'update.json',
        'update.json.sig',
      ].map((path) => `${name}/${path}`)
    )
    expect(members.get(`${name}/update.json`)!.data).toBe(
      await readFile(join(directory, 'update.json'), 'utf8')
    )
    const script = members.get(`${name}/install.sh`)!
    if (!windows) expect(script.mode).toBe(0o755)
    expect(script.data).toContain(
      '"$here/bun-native-update" install "$here/update.json" --payload "$here/payload" --root "$root" --key-set "$here/keys.json"'
    )
    expect(script.data).toContain(
      `"$here/bun-native-update" integrate --root "$root" --name 'Example App' --applications "$menu" --verified-launcher "$here/launcher"`
    )
    expect(script.data).toContain(
      'root=${1:-"${XDG_DATA_HOME:-$HOME/.local/share}/dev.bun-native.example"}'
    )
    const again = await temporary()
    const second = await createInstaller(directory, again, {
      format: 'tar.gz',
      name: 'Example App',
    })
    expect(second.digest).toEqual(record.digest)
    await expect(
      createInstaller(directory, out, { format: 'tar.gz', name: 'Example App' })
    ).rejects.toThrow('already exists')
  })

  test('zip: a Windows bundle with a PowerShell install script, byte-reproducible', async () => {
    const { directory, out } = await bundleFor('win32', 'unsigned-experimental')
    const record = await createInstaller(directory, out, { format: 'zip', name: 'Example App' })
    const members = unzip(await readFile(record.file))
    const prefix = `dev.bun-native.example-1.2.3-win32-${process.arch}/`
    expect(members.has(`${prefix}payload/application.exe`)).toBe(true)
    expect(members.has(`${prefix}launcher.exe`)).toBe(true)
    const script = members.get(`${prefix}install.ps1`)!.data
    expect(script).toContain('\r\n')
    expect(script).toContain(
      "& $tool install (Join-Path $PSScriptRoot 'update.json') --payload (Join-Path $PSScriptRoot 'payload') --root $Root --unsigned-experimental"
    )
    expect(script).toContain(
      "[string]$Root = (Join-Path $env:LOCALAPPDATA 'Programs\\dev.bun-native.example')"
    )
    expect(script).toContain(
      "& $tool integrate --root $Root --name 'Example App' --applications $Menu --verified-launcher (Join-Path $PSScriptRoot 'launcher.exe')"
    )
    const again = await temporary()
    expect(
      (await createInstaller(directory, again, { format: 'zip', name: 'Example App' })).digest
    ).toEqual(record.digest)
  })

  test('images compress at level 6, which differs from level 9 on executable bytes', async () => {
    expect(INSTALLER_COMPRESSION_LEVEL).toBe(6)
    // Two MiB of a real executable: enough for the zlib levels to choose differently.
    const executable = (await readFile(process.execPath)).subarray(0, 2 * 1024 * 1024)
    const { directory, out } = await bundleFor('linux', 'ed25519', true, executable)
    const archive = await readFile(
      (await createInstaller(directory, out, { format: 'tar.gz', name: 'Example App' })).file
    )
    const gzip = (level: number) => {
      const bytes = gzipSync(gunzipSync(archive), { level })
      bytes[9] = 0xff // the writer's fixed OS byte
      return bytes
    }
    expect(archive.equals(gzip(6))).toBe(true)
    expect(archive.equals(gzip(9))).toBe(false)
    expect(deflateRawSync(executable, { level: 6 }).length).toBeGreaterThan(
      deflateRawSync(executable, { level: 9 }).length
    )
    const zip = zipArchive([{ name: 'application', data: executable, mode: 0o755 }])
    expect(zip.includes(deflateRawSync(executable, { level: 6 }))).toBe(true)
  })

  test('zip writer output is a standard archive', async () => {
    // Windows runners name it python; a python3 there may be the Store alias stub.
    const python = Bun.which(process.platform === 'win32' ? 'python' : 'python3')
    const entries = [
      { name: 'b/one.txt', data: Buffer.from('one'), mode: 0o644 },
      { name: 'a.exe', data: Buffer.alloc(100_000, 7), mode: 0o755 },
    ]
    const archive = zipArchive(entries)
    expect([...unzip(archive).entries()].map(([name, { mode }]) => [name, mode])).toEqual([
      ['a.exe', 0o100755],
      ['b/one.txt', 0o100644],
    ])
    if (!python) return
    const file = join(await temporary(), 'x.zip')
    await writeFile(file, archive)
    const checked = Bun.spawnSync([
      python,
      '-c',
      'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(sorted((i.filename, i.file_size) for i in z.infolist()))',
      file,
    ])
    expect(checked.stdout.toString().trim()).toBe("[('a.exe', 100000), ('b/one.txt', 3)]")
  })

  test('refuses incomplete bundles, foreign formats and unsafe names', async () => {
    const linux = await bundleFor('linux')
    await expect(
      createInstaller(linux.directory, linux.out, { format: 'zip', name: 'Example App' })
    ).rejects.toThrow('A zip installer is not built for linux')
    await expect(
      createInstaller(linux.directory, linux.out, { format: 'tar.gz', name: "x'; rm -rf ~" })
    ).rejects.toThrow('Application names use')
    const toolless = await bundleFor('linux', 'ed25519', false)
    await expect(
      createInstaller(toolless.directory, toolless.out, { format: 'tar.gz', name: 'Example App' })
    ).rejects.toThrow(
      'The bundle has no bun-native-update; create it with bundle --self-contained --key-set'
    )
    const tampered = await bundleFor('linux')
    await appendFile(join(tampered.directory, 'payload/application'), 'x')
    await expect(
      createInstaller(tampered.directory, tampered.out, { format: 'tar.gz', name: 'Example App' })
    ).rejects.toThrow('payload/application does not match update.json')
    if (process.platform !== 'darwin') {
      const mac = await bundleFor('darwin')
      await expect(
        createInstaller(mac.directory, mac.out, { format: 'dmg', name: 'Example App' })
      ).rejects.toThrow('Disk images are built on macOS')
    }
    expect(await readdir(linux.out)).toEqual([])
  })
})

describe('signed installer paths with a recording runner', () => {
  type Call = string[]
  const ok = (stdout = '', stderr = '') => ({ exitCode: 0, stdout, stderr })

  test('dmg: hdiutil is retried, then the image is signed, verified and its authority read', async () => {
    const { directory, out } = await bundleFor('darwin')
    const calls: Call[] = []
    let creates = 0
    const runner = (command: Call) => {
      calls.push(command)
      if (command[0] === 'hdiutil') {
        creates++
        if (creates === 1) return { exitCode: 1, stdout: '', stderr: 'Resource busy' }
        writeFileSync(command.at(-1)!, 'image')
        return ok()
      }
      if (command.includes('--display')) return ok('', 'Authority=Developer ID Application: X\n')
      return ok()
    }
    const record = await createInstaller(directory, out, {
      format: 'dmg',
      name: 'Example App',
      platform: 'darwin',
      runner,
      signing: { platform: 'darwin', identity: 'ABC', timestamp: true, keychain: '/k' } as never,
    })
    expect(creates).toBe(2)
    expect(record.imageSignature).toBe('Developer ID Application: X')
    expect(calls.find((c) => c[0] === 'codesign' && c[1] === '--force')).toEqual([
      'codesign',
      '--force',
      '--sign',
      'ABC',
      '--timestamp',
      '--keychain',
      '/k',
      record.file,
    ])
    expect(record.digest.bytes).toBe(5)
  })

  test('dmg: ad-hoc signatures skip the timestamp and failures stop the build', async () => {
    const adhoc = await bundleFor('darwin')
    const calls: Call[] = []
    const record = await createInstaller(adhoc.directory, adhoc.out, {
      format: 'dmg',
      name: 'Example App',
      platform: 'darwin',
      runner: (command) => {
        calls.push(command)
        if (command[0] === 'hdiutil') writeFileSync(command.at(-1)!, 'image')
        return ok()
      },
      signing: { platform: 'darwin', identity: '-', timestamp: true } as never,
    })
    expect(record.imageSignature).toBe('ad-hoc')
    expect(calls.some((c) => c.includes('--timestamp=none'))).toBe(true)

    const failing = (fails: (c: Call) => boolean) => (command: Call) =>
      fails(command) ? { exitCode: 1, stdout: 'out', stderr: 'err' } : ok()
    for (const [fails, message] of [
      [(c: Call) => c[0] === 'hdiutil', 'hdiutil create failed'],
      [(c: Call) => c[1] === '--force', 'Signing the disk image failed'],
      [(c: Call) => c[1] === '--verify', 'The disk image signature is invalid'],
    ] as const) {
      const { directory, out } = await bundleFor('darwin')
      await expect(
        createInstaller(directory, out, {
          format: 'dmg',
          name: 'Example App',
          platform: 'darwin',
          runner: failing(fails),
          signing: { platform: 'darwin', identity: 'ABC', timestamp: false } as never,
        })
      ).rejects.toThrow(message)
    }
  })

  test('zip: the Windows install script is signed and its authority recorded', async () => {
    const { directory, out } = await bundleFor('win32', 'unsigned-experimental')
    const calls: Call[] = []
    const record = await createInstaller(directory, out, {
      format: 'zip',
      name: 'Example App',
      runner: (command) => {
        calls.push(command)
        return command[1] === 'verify'
          ? ok(
              'Signing Certificate Chain:\n    Issued to: Root CA\n        Issued to: Example Signer\nThe signature is timestamped: Mon Nov 10 2026\n'
            )
          : ok()
      },
      signing: {
        platform: 'win32',
        signtool: 'signtool',
        certificate: { thumbprint: 'AB12' },
        timestampUrl: 'http://timestamp.example',
      } as never,
    })
    expect(calls[0]?.slice(0, 2)).toEqual(['signtool', 'sign'])
    expect(calls[0]?.at(-1)).toEndWith('install.ps1')
    expect(record.scriptSignature).toBeDefined()
  })

  test("an installer cannot be signed with another platform's tools", async () => {
    const { directory, out } = await bundleFor('win32', 'unsigned-experimental')
    await expect(
      createInstaller(directory, out, {
        format: 'zip',
        name: 'Example App',
        signing: { platform: 'darwin', identity: '-', timestamp: false } as never,
      })
    ).rejects.toThrow('A win32 installer cannot be signed with darwin tools')
  })
})

function cli(script: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, join(repository, script), ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  })
  expect({ args, code: result.exitCode, err: result.stderr.toString() }).toMatchObject({
    code: 0,
    err: '',
  })
  return result.stdout.toString()
}

// The whole unsigned path on this machine: keyed update manifest, self-contained bundle,
// installer image, extraction, the image's own install script, then a start through the
// installed verifying launcher. macOS and Windows CI run it in `bun test tests`.
test('an installer image installs and starts through its own script and launcher', async () => {
  const build = await temporary()
  // A small stand-in application keeps the image to the two real compiled tools. Windows
  // launches only executables, so it still copies Bun there.
  if (windows) await copyFile(process.execPath, join(build, `application${exe}`))
  else
    await writeFile(
      join(build, 'application'),
      '#!/bin/sh\nprintf \'%s\\n\' "$BUN_NATIVE_DATA_DIR"\n',
      { mode: 0o755 }
    )
  await writeFile(join(build, `bun-native-host${exe}`), 'host\n')
  await writeFile(
    join(build, 'manifest.json'),
    JSON.stringify({
      target: { os: process.platform, architecture: process.arch },
      toolchain: { bun: { revision: toolchain.bun.revision } },
      application: {
        file: `application${exe}`,
        ...(await fileDigest(join(build, `application${exe}`))),
      },
      host: {
        file: `bun-native-host${exe}`,
        ...(await fileDigest(join(build, `bun-native-host${exe}`))),
      },
    })
  )
  const work = await temporary()
  const key = join(work, 'release.pem')
  const update = (...args: string[]) => cli('scripts/release-update.ts', ...args)
  update('keygen', '--private-key', key, '--public-key', join(work, 'release.pub.pem'))
  update(
    'key-set',
    '--product',
    'dev.bun-native.example',
    '--version',
    '1',
    '--minimum-sequence',
    '1',
    '--public-key',
    join(work, 'release.pub.pem'),
    '--out',
    join(work, 'keys.json')
  )
  const manifest = join(work, 'update.json')
  update(
    'manifest',
    build,
    '--product',
    'dev.bun-native.example',
    '--version',
    '1.0.0',
    '--sequence',
    '1',
    '--signed',
    '--out',
    manifest
  )
  update('sign', manifest, '--private-key', key, '--keyed')
  const bundles = join(work, 'bundles')
  await mkdir(bundles)
  update(
    'bundle',
    manifest,
    '--payload',
    build,
    '--out',
    bundles,
    '--self-contained',
    '--key-set',
    join(work, 'keys.json')
  )
  const [bundle] = await readdir(bundles)
  const installers = join(work, 'installers')
  await mkdir(installers)
  const record = JSON.parse(
    cli(
      'scripts/release-package.ts',
      'installer',
      join(bundles, bundle!),
      '--format',
      windows ? 'zip' : 'tar.gz',
      '--name',
      'Example App',
      '--out',
      installers
    )
  ) as { file: string }
  const extracted = join(work, 'extracted')
  await mkdir(extracted)
  const tar = windows
    ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
  expect(Bun.spawnSync([tar, '-xf', record.file, '-C', extracted]).exitCode).toBe(0)
  const root = join(work, 'install root')
  const script = join(extracted, bundle!, windows ? 'install.ps1' : 'install.sh')
  const installed = Bun.spawnSync(
    windows
      ? [
          'pwsh',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          script,
          '-Root',
          root,
          '-Menu',
          join(work, 'menu'),
        ]
      : ['/bin/sh', script, root, join(work, 'menu')],
    { stdout: 'pipe', stderr: 'pipe', timeout: 120_000 }
  )
  expect({ code: installed.exitCode, err: installed.stderr.toString() }).toEqual({
    code: 0,
    err: '',
  })
  expect(JSON.parse(update('status', '--root', root))).toMatchObject({
    version: '1.0.0',
    trust: { kind: 'ed25519' },
  })
  const started = Bun.spawnSync(
    [
      join(root, 'bin', `dev.bun-native.example${exe}`),
      '-e',
      'console.log(process.env.BUN_NATIVE_DATA_DIR)',
    ],
    { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 }
  )
  expect(started.exitCode).toBe(0)
  // The launcher finds the root from its resolved executable path (/private/var on macOS).
  expect(started.stdout.toString().trim()).toBe(join(await realpath(root), 'data'))
}, 300_000)
