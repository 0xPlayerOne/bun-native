#!/usr/bin/env bun
import { generateKeyPairSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import toolchain from '../toolchain.json'
import { PROTOCOL_VERSION } from '../packages/protocol/src/index.ts'
import {
  acceptKeySet,
  currentRelease,
  directorySource,
  httpSource,
  install,
  recover,
  rollback,
  trustedKeySet,
  uninstall,
} from './native/installation.ts'
import { createBundle, integrate, type Platform } from './native/installer.ts'
import { confirmHealthy, reportUnhealthy } from './native/lifecycle.ts'
import {
  decodeKeySet,
  parseKeySet,
  signWithKey,
  trustedKey,
  verifyKeyedUpdate,
  type KeySet,
} from './native/update-keys.ts'
import {
  createUpdateManifest,
  signUpdate,
  verifyUpdate,
  type TrustPolicy,
  type VerifiedUpdate,
} from './native/update-manifest.ts'
import { runVerified } from './native/verified-launcher.ts'

const usage = `Experimental Bun Native application updates (see docs/updates.md and docs/update-lifecycle.md)

  bun scripts/release-update.ts manifest BUILD_DIR --product ID --version X.Y.Z --sequence N (--signed | --unsigned-experimental) --out update.json
  bun scripts/release-update.ts keygen --private-key /absolute/new-private.pem --public-key new-public.pem
  bun scripts/release-update.ts key-set --product ID --version N --minimum-sequence N --public-key PEM_PATH ... [--revoke KEY_ID ...] --out keys.json
  bun scripts/release-update.ts sign FILE --private-key /absolute/ed25519-private.pem [--keyed]
  bun scripts/release-update.ts install update.json --root INSTALL_DIR --payload BUILD_DIR_OR_HTTPS_URL TRUST [--rotation next-keys.json] [--health-limit N]
      TRUST is --public-key PEM_PATH ... | --key-set keys.json | --unsigned-experimental
  bun scripts/release-update.ts rotate next-keys.json --root INSTALL_DIR --key-set keys.json
  bun scripts/release-update.ts launch --root INSTALL_DIR [--key-set keys.json] [-- APPLICATION_ARGS ...]
  bun scripts/release-update.ts confirm|report-unhealthy --root INSTALL_DIR --release MANIFEST_SHA256 [--key-set keys.json]
  bun scripts/release-update.ts rollback|recover|status --root INSTALL_DIR [--key-set keys.json]
  bun scripts/release-update.ts bundle update.json --payload BUILD_DIR --out EXISTING_DIR [--self-contained [--key-set keys.json]]
  bun scripts/release-update.ts launcher --out NEW_EXECUTABLE
  bun scripts/release-update.ts integrate --root INSTALL_DIR --name "App Name" --applications MENU_DIR [--verified-launcher EXECUTABLE]
  bun scripts/release-update.ts uninstall --root INSTALL_DIR [--purge-data]

Keys are read only from caller-supplied files at runtime and are never stored by this tool.
Unsigned manifests are experimental, labeled as such and must be accepted explicitly.`

const optional = async (path: string) => {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Compile one of these scripts into a standalone executable for this machine. */
function compile(script: string, out: string): void {
  const entry = join(import.meta.dir, script)
  // A compiled copy of this tool has no sources or Bun to compile with.
  if (!existsSync(entry)) throw new Error('Building executables needs the Bun Native repository')
  const built = Bun.spawnSync(
    [process.execPath, 'build', '--compile', '--minify', entry, '--outfile', out],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  if (built.exitCode !== 0) throw new Error(`Building ${script} failed\n${built.stderr.toString()}`)
}

const readKeySetFile = async (path: string) => decodeKeySet(await readFile(path))

async function main(argv: string[]): Promise<void> {
  // Arguments after `--` belong to the launched application.
  const separator = argv.indexOf('--')
  const args = separator === -1 ? argv : argv.slice(0, separator)
  const forwarded = separator === -1 ? [] : argv.slice(separator + 1)
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      product: { type: 'string' },
      version: { type: 'string' },
      sequence: { type: 'string' },
      'minimum-sequence': { type: 'string' },
      signed: { type: 'boolean' },
      'unsigned-experimental': { type: 'boolean' },
      keyed: { type: 'boolean' },
      out: { type: 'string' },
      'private-key': { type: 'string' },
      'public-key': { type: 'string', multiple: true },
      'key-set': { type: 'string' },
      revoke: { type: 'string', multiple: true },
      rotation: { type: 'string' },
      'health-limit': { type: 'string' },
      release: { type: 'string' },
      root: { type: 'string' },
      payload: { type: 'string' },
      name: { type: 'string' },
      applications: { type: 'string' },
      'verified-launcher': { type: 'string' },
      'purge-data': { type: 'boolean' },
      'self-contained': { type: 'boolean' },
    },
  })
  const [command, input, ...extra] = positionals
  if (!command || extra.length || (forwarded.length && command !== 'launch')) {
    console.log(usage)
    if (command) process.exitCode = 1
    return
  }
  const unsigned = values['unsigned-experimental'] === true
  if (command === 'manifest') {
    if (!input || !values.out || !values.product || !values.version || !values.sequence)
      throw new Error(usage)
    if (unsigned === (values.signed === true))
      throw new Error('Choose exactly one of --signed or --unsigned-experimental')
    const manifest = await createUpdateManifest(resolve(input), {
      product: values.product,
      version: values.version,
      sequence: Number(values.sequence),
      trust: unsigned ? 'unsigned-experimental' : 'ed25519',
      protocol: PROTOCOL_VERSION,
    })
    await writeFile(values.out, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    console.log(`Wrote ${manifest.trust} update manifest ${values.out}`)
    return
  }
  if (command === 'keygen') {
    const privatePath = values['private-key']
    const publicPath = values['public-key']?.[0]
    if (input || !privatePath || !isAbsolute(privatePath) || values['public-key']?.length !== 1)
      throw new Error(usage)
    const pair = generateKeyPairSync('ed25519')
    const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    // Both outputs are checked first so that a refusal never leaves half a key pair.
    for (const path of [privatePath, publicPath!])
      if (existsSync(path)) throw new Error(`${path} already exists`)
    await writeFile(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      flag: 'wx',
      mode: 0o600,
    })
    await writeFile(publicPath!, publicPem, { flag: 'wx' })
    console.log(JSON.stringify({ key: trustedKey(publicPem).id, publicKey: publicPath }))
    return
  }
  if (command === 'key-set') {
    const keys = values['public-key'] ?? []
    if (input || !values.out || !values.product || !values.version || !keys.length)
      throw new Error(usage)
    const set: KeySet = parseKeySet({
      schemaVersion: 1,
      product: values.product,
      version: Number(values.version),
      minimumSequence: Number(values['minimum-sequence'] ?? '0'),
      keys: await Promise.all(keys.map(async (path) => trustedKey(await readFile(path, 'utf8')))),
      revoked: values.revoke ?? [],
    })
    await writeFile(values.out, JSON.stringify(set, null, 2) + '\n', { flag: 'wx' })
    console.log(`Wrote key set ${values.out} version ${set.version}`)
    return
  }
  if (command === 'sign') {
    const key = values['private-key']
    if (!input || !key || !isAbsolute(key)) throw new Error(usage)
    const sign = values.keyed ? signWithKey : signUpdate
    await writeFile(`${input}.sig`, sign(await readFile(input), await readFile(key, 'utf8')), {
      flag: 'wx',
    })
    console.log(`Wrote detached ${values.keyed ? 'keyed ' : ''}Ed25519 signature ${input}.sig`)
    return
  }
  if (command === 'bundle') {
    if (!input || !values.payload || !values.out) throw new Error(usage)
    const selfContained = values['self-contained'] === true
    if (values['key-set'] && !selfContained)
      throw new Error('--key-set is copied only into a --self-contained bundle\n' + usage)
    const keySet = values['key-set'] ? await readFile(values['key-set']) : undefined
    if (keySet) decodeKeySet(keySet)
    if (selfContained) {
      const { target } = JSON.parse(await readFile(input, 'utf8')) as {
        target?: { os?: string; architecture?: string }
      }
      // The tools are compiled for this machine, so they must match the release target.
      if (target?.os !== process.platform || target?.architecture !== process.arch)
        throw new Error(
          `A self-contained bundle for ${target?.os}/${target?.architecture} must be built on that platform`
        )
    }
    const { directory, signed } = await createBundle(
      resolve(values.payload),
      input,
      values.out,
      selfContained ? { selfContained: { keySet: keySet !== undefined } } : {}
    )
    if (selfContained) {
      const exe = process.platform === 'win32' ? '.exe' : ''
      compile('release-update.ts', join(directory, `bun-native-update${exe}`))
      compile('native/verified-launcher.ts', join(directory, `launcher${exe}`))
      if (keySet) await writeFile(join(directory, 'keys.json'), keySet, { flag: 'wx' })
    }
    console.log(
      `Wrote ${signed ? 'signed-manifest' : 'UNSIGNED EXPERIMENTAL'}${selfContained ? ' self-contained' : ''} bundle ${directory}`
    )
    return
  }
  if (command === 'launcher') {
    if (input || !values.out) throw new Error(usage)
    const out = resolve(values.out)
    if (existsSync(out)) throw new Error(`${out} already exists`)
    compile('native/verified-launcher.ts', out)
    console.log(`Wrote verifying launcher ${out}`)
    return
  }
  if (!values.root) throw new Error(usage)
  const root = values.root
  const bootstrap = values['key-set'] ? await readKeySetFile(values['key-set']) : undefined
  const effectiveKeys = bootstrap ? await trustedKeySet(root, bootstrap) : undefined
  const keyOptions = effectiveKeys ? { keys: effectiveKeys } : {}
  if (command === 'integrate') {
    if (!values.name || !values.applications) throw new Error(usage)
    if (!['linux', 'darwin', 'win32'].includes(process.platform))
      throw new Error(`Desktop integration is unsupported on ${process.platform}`)
    const paths = await integrate(root, {
      platform: process.platform as Platform,
      name: values.name,
      applications: values.applications,
      ...(values['verified-launcher'] ? { verifiedLauncher: values['verified-launcher'] } : {}),
    })
    console.log(JSON.stringify({ created: paths }))
    return
  }
  if (command === 'uninstall') {
    const result = await uninstall(root, { purgeData: values['purge-data'] === true })
    console.log(JSON.stringify(result))
    return
  }
  if (command === 'rotate') {
    if (!input || !bootstrap) throw new Error(usage)
    const next = await acceptKeySet(
      root,
      bootstrap,
      await readFile(input),
      await optional(`${input}.sig`)
    )
    console.log(JSON.stringify({ keySet: next.version, keys: next.keys.map((key) => key.id) }))
    return
  }
  if (command === 'install') {
    const keys = values['public-key'] ?? []
    const modes = [unsigned, keys.length > 0, bootstrap !== undefined].filter(Boolean).length
    if (!input || !values.payload || modes !== 1)
      throw new Error('install requires --payload and exactly one trust mode\n' + usage)
    if (values.rotation && !bootstrap) throw new Error('--rotation requires --key-set\n' + usage)
    const requirements = {
      os: process.platform,
      architecture: process.arch,
      protocol: PROTOCOL_VERSION,
      bunRevision: toolchain.bun.revision,
    }
    const bytes = await readFile(input)
    const signature = await optional(`${input}.sig`)
    let update: VerifiedUpdate
    if (bootstrap) {
      // A rotation shipped beside the update is accepted first, so the update may be signed
      // by a key that only the new set trusts.
      const trusted = values.rotation
        ? await acceptKeySet(
            root,
            bootstrap,
            await readFile(values.rotation),
            await optional(`${values.rotation}.sig`)
          )
        : effectiveKeys!
      update = verifyKeyedUpdate(bytes, signature, trusted, requirements)
    } else {
      const policy: TrustPolicy = unsigned
        ? { kind: 'unsigned-experimental' }
        : {
            kind: 'ed25519',
            publicKeys: await Promise.all(keys.map((path) => readFile(path, 'utf8'))),
          }
      update = verifyUpdate(bytes, signature, policy, requirements)
    }
    const source = /^https?:\/\//.test(values.payload)
      ? httpSource(new URL(values.payload.endsWith('/') ? values.payload : `${values.payload}/`))
      : directorySource(resolve(values.payload))
    const limit = values['health-limit']
    const state = await install(
      root,
      update,
      source,
      limit === undefined ? {} : { health: { limit: Number(limit) } }
    )
    console.log(JSON.stringify({ installed: state.current, health: state.health }, null, 2))
    if (update.trust.kind === 'unsigned-experimental')
      console.log('WARNING: installed an UNSIGNED EXPERIMENTAL update')
    return
  }
  if (command === 'launch') {
    process.exitCode = await runVerified(root, forwarded, effectiveKeys)
    return
  }
  if (command === 'confirm' || command === 'report-unhealthy') {
    if (!values.release) throw new Error(usage)
    const state =
      command === 'confirm'
        ? await confirmHealthy(root, values.release)
        : await reportUnhealthy(root, values.release, keyOptions)
    console.log(JSON.stringify({ current: state.current.version, failed: state.failed }))
    return
  }
  if (command === 'rollback') {
    const state = await rollback(root, keyOptions)
    console.log(`Rolled back to ${state.current.version} (${state.current.directory})`)
    return
  }
  if (command === 'recover') {
    console.log(JSON.stringify({ removed: await recover(root) }))
    return
  }
  if (command === 'status') {
    const { directory, release } = await currentRelease(root)
    console.log(
      JSON.stringify({
        directory,
        version: release.version,
        trust: release.trust,
        release: release.manifestSha256,
      })
    )
    return
  }
  throw new Error(`Unknown command ${command}\n${usage}`)
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
