import { expect } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import toolchain from '../../toolchain.json'
import { PROTOCOL_VERSION } from '../../packages/protocol/src/index.ts'
import { fileDigest } from '../../scripts/native/artifact.ts'
import { currentRelease } from '../../scripts/native/installation.ts'
import {
  createUpdateManifest,
  signUpdate,
  UpdateError,
  type HostRequirements,
  type TrustPolicy,
  type UpdateManifest,
} from '../../scripts/native/update-manifest.ts'

export const repository = resolve(import.meta.dir, '../..')
export const requirements: HostRequirements = {
  os: process.platform,
  architecture: process.arch,
  protocol: PROTOCOL_VERSION,
  bunRevision: toolchain.bun.revision,
}
export const keys = generateKeyPairSync('ed25519')
export const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
export const signed: TrustPolicy = { kind: 'ed25519', publicKeys: [publicPem] }
const directories: string[] = []

/**
 * Windows keeps an executable's file locked briefly after its process exits
 * (and while antivirus scans a newly written one), so removing a directory
 * that held a just-run application can fail with EBUSY or EPERM (Protocol and
 * AOT windows-2022, run 43149936296, after the test itself passed). Retry
 * those two errors for up to two seconds, as Node's `rm` `maxRetries` does;
 * anything else, or a lock that outlasts the bound, still fails the test.
 */
async function remove(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || (code !== 'EBUSY' && code !== 'EPERM') || attempt === 19)
        throw error
      await Bun.sleep(100)
    }
  }
}

export async function cleanup(): Promise<void> {
  for (const directory of directories.splice(0)) await remove(directory)
}

export async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-update-'))
  directories.push(directory)
  return directory
}

/** A synthetic `native build` output with the fields the updater cross-checks. */
export async function build(label: string): Promise<string> {
  const directory = await temporary()
  const suffix = process.platform === 'win32' ? '.exe' : ''
  await writeFile(join(directory, `application${suffix}`), `application ${label}\n`)
  await writeFile(join(directory, `bun-native-host${suffix}`), `host ${label}\n`)
  await mkdir(join(directory, 'development'))
  await writeFile(join(directory, 'development/application.js'), `console.log(${label})\n`)
  const manifest = {
    schemaVersion: 1,
    target: { os: process.platform, architecture: process.arch },
    toolchain: { bun: { revision: toolchain.bun.revision } },
    application: {
      file: `application${suffix}`,
      ...(await fileDigest(join(directory, `application${suffix}`))),
    },
    host: {
      file: `bun-native-host${suffix}`,
      ...(await fileDigest(join(directory, `bun-native-host${suffix}`))),
    },
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return directory
}

export async function release(
  label: string,
  sequence: number,
  trust: UpdateManifest['trust'] = 'ed25519',
  edit?: (manifest: UpdateManifest) => void
) {
  const payload = await build(label)
  const manifest = await createUpdateManifest(payload, {
    product: 'dev.bun-native.example',
    version: `1.0.${sequence}`,
    sequence,
    trust,
    protocol: requirements.protocol,
  })
  edit?.(manifest)
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  const signature =
    trust === 'ed25519' ? Buffer.from(signUpdate(bytes, keys.privateKey)) : undefined
  return { payload, manifest, bytes, signature }
}

export async function rejects(
  promise: Promise<unknown> | (() => unknown),
  code: UpdateError['code']
) {
  let error: unknown
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(UpdateError)
  expect((error as UpdateError).code).toBe(code)
  return error as UpdateError
}

export async function installed(root: string, label: string) {
  const { directory } = await currentRelease(root)
  const application = (await readdir(directory)).find((name) => name.startsWith('application'))!
  expect(await readFile(join(directory, application), 'utf8')).toBe(`application ${label}\n`)
}

export async function leftovers(root: string) {
  return {
    staging: await readdir(join(root, 'staging')),
    lock: existsSync(join(root, 'lock')),
    temporary: (await readdir(root)).filter((name) => name.endsWith('.tmp')),
  }
}

export const clean = { staging: [], lock: false, temporary: [] }
