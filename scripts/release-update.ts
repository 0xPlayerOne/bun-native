#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import toolchain from '../toolchain.json'
import { PROTOCOL_VERSION } from '../packages/protocol/src/index.ts'
import {
  currentRelease,
  directorySource,
  httpSource,
  install,
  recover,
  rollback,
  uninstall,
} from './native/installation.ts'
import { createBundle, integrate, type Platform } from './native/installer.ts'
import {
  createUpdateManifest,
  signUpdate,
  verifyUpdate,
  type TrustPolicy,
} from './native/update-manifest.ts'

const usage = `Experimental Bun Native application updates (see docs/updates.md)

  bun scripts/release-update.ts manifest BUILD_DIR --product ID --version X.Y.Z --sequence N (--signed | --unsigned-experimental) --out update.json
  bun scripts/release-update.ts sign update.json --private-key /absolute/ed25519-private.pem
  bun scripts/release-update.ts install update.json --root INSTALL_DIR --payload BUILD_DIR_OR_HTTPS_URL (--public-key PEM_PATH ... | --unsigned-experimental)
  bun scripts/release-update.ts rollback|recover|status --root INSTALL_DIR
  bun scripts/release-update.ts bundle update.json --payload BUILD_DIR --out EXISTING_DIR
  bun scripts/release-update.ts integrate --root INSTALL_DIR --name "App Name" --applications MENU_DIR
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

async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      product: { type: 'string' },
      version: { type: 'string' },
      sequence: { type: 'string' },
      signed: { type: 'boolean' },
      'unsigned-experimental': { type: 'boolean' },
      out: { type: 'string' },
      'private-key': { type: 'string' },
      'public-key': { type: 'string', multiple: true },
      root: { type: 'string' },
      payload: { type: 'string' },
      name: { type: 'string' },
      applications: { type: 'string' },
      'purge-data': { type: 'boolean' },
    },
  })
  const [command, input, ...extra] = positionals
  if (!command || extra.length) {
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
  if (command === 'sign') {
    const key = values['private-key']
    if (!input || !key || !isAbsolute(key)) throw new Error(usage)
    await writeFile(
      `${input}.sig`,
      signUpdate(await readFile(input), await readFile(key, 'utf8')),
      {
        flag: 'wx',
      }
    )
    console.log(`Wrote detached Ed25519 signature ${input}.sig`)
    return
  }
  if (command === 'bundle') {
    if (!input || !values.payload || !values.out) throw new Error(usage)
    const { directory, signed } = await createBundle(resolve(values.payload), input, values.out)
    console.log(`Wrote ${signed ? 'signed-manifest' : 'UNSIGNED EXPERIMENTAL'} bundle ${directory}`)
    return
  }
  if (!values.root) throw new Error(usage)
  if (command === 'integrate') {
    if (!values.name || !values.applications) throw new Error(usage)
    if (!['linux', 'darwin', 'win32'].includes(process.platform))
      throw new Error(`Desktop integration is unsupported on ${process.platform}`)
    const paths = await integrate(values.root, {
      platform: process.platform as Platform,
      name: values.name,
      applications: values.applications,
    })
    console.log(JSON.stringify({ created: paths }))
    return
  }
  if (command === 'uninstall') {
    const result = await uninstall(values.root, { purgeData: values['purge-data'] === true })
    console.log(JSON.stringify(result))
    return
  }
  if (command === 'install') {
    const keys = values['public-key'] ?? []
    if (!input || !values.payload || unsigned === keys.length > 0)
      throw new Error('install requires --payload and exactly one trust mode\n' + usage)
    const policy: TrustPolicy = unsigned
      ? { kind: 'unsigned-experimental' }
      : {
          kind: 'ed25519',
          publicKeys: await Promise.all(keys.map((path) => readFile(path, 'utf8'))),
        }
    const update = verifyUpdate(await readFile(input), await optional(`${input}.sig`), policy, {
      os: process.platform,
      architecture: process.arch,
      protocol: PROTOCOL_VERSION,
      bunRevision: toolchain.bun.revision,
    })
    const source = /^https?:\/\//.test(values.payload)
      ? httpSource(new URL(values.payload.endsWith('/') ? values.payload : `${values.payload}/`))
      : directorySource(resolve(values.payload))
    const state = await install(values.root, update, source)
    console.log(JSON.stringify({ installed: state.current }, null, 2))
    if (update.trust.kind === 'unsigned-experimental')
      console.log('WARNING: installed an UNSIGNED EXPERIMENTAL update')
    return
  }
  if (command === 'rollback') {
    const state = await rollback(values.root)
    console.log(`Rolled back to ${state.current.version} (${state.current.directory})`)
    return
  }
  if (command === 'recover') {
    console.log(JSON.stringify({ removed: await recover(values.root) }))
    return
  }
  if (command === 'status') {
    const { directory, release } = await currentRelease(values.root)
    console.log(JSON.stringify({ directory, version: release.version, trust: release.trust }))
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
