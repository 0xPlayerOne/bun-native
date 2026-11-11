#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createInstaller, type InstallerFormat } from './native/installer-image.ts'
import { notarize, notaryCredentials } from './native/notarize.ts'
import {
  defaultTimestampUrl,
  entitlementsPath,
  findSigntool,
  runCommand,
  signBuild,
  signBundle,
  verifyTree,
  type SigningIdentity,
} from './native/signing.ts'

const usage = `Bun Native OS code signing and installers (see docs/releasing.md)

  bun scripts/release-package.ts sign DIR SIGNING
      DIR is a native build output (manifest.json) or a bundle --self-contained (update.json)
  bun scripts/release-package.ts verify PATH ...
  bun scripts/release-package.ts installer BUNDLE_DIR --format dmg|zip|tar.gz --name "App Name" --out EXISTING_DIR [SIGNING]
  bun scripts/release-package.ts notarize IMAGE.dmg

  SIGNING on macOS:   --identity SHA1_OR_NAME [--keychain PATH] [--entitlements PLIST] [--no-timestamp]
  SIGNING on Windows: --identity CERTIFICATE_THUMBPRINT | --dlib PATH --dlib-metadata JSON
                      [--timestamp-url URL | --no-timestamp] (signtool from the Windows SDK or SIGNTOOL)

Sign a build before creating its update manifest, and the bundle before its installer.
Identities are provisioned by the caller (scripts/signing/); no key material is read here.
notarize reads APPLE_NOTARY_KEY_ID, APPLE_NOTARY_ISSUER_ID and APPLE_NOTARY_PRIVATE_KEY, or
APPLE_ID, APPLE_TEAM_ID and APPLE_APP_SPECIFIC_PASSWORD, and skips with a reason without them.`

type Values = {
  identity?: string | undefined
  keychain?: string | undefined
  entitlements?: string | undefined
  'no-timestamp'?: boolean | undefined
  'timestamp-url'?: string | undefined
  dlib?: string | undefined
  'dlib-metadata'?: string | undefined
}

function signingIdentity(values: Values, required: boolean): SigningIdentity | undefined {
  const given = values.identity !== undefined || values.dlib !== undefined
  if (!given) {
    if (required) throw new Error(`Signing needs --identity\n${usage}`)
    return undefined
  }
  const timestamp = values['no-timestamp'] !== true
  if (process.platform === 'darwin') {
    if (!values.identity || values.dlib) throw new Error('macOS signing takes --identity')
    if (values['timestamp-url']) throw new Error('codesign uses the Apple timestamp server')
    return {
      platform: 'darwin',
      identity: values.identity,
      ...(values.keychain ? { keychain: resolve(values.keychain) } : {}),
      entitlements: resolve(values.entitlements ?? entitlementsPath),
      timestamp,
    }
  }
  if (process.platform === 'win32') {
    if (values.keychain || values.entitlements)
      throw new Error('--keychain and --entitlements are macOS options')
    if (!!values.identity === !!values.dlib || !!values.dlib !== !!values['dlib-metadata'])
      throw new Error('Windows signing takes --identity, or --dlib with --dlib-metadata')
    if (!timestamp && values['timestamp-url'])
      throw new Error('Choose --timestamp-url or --no-timestamp')
    return {
      platform: 'win32',
      signtool: findSigntool(),
      certificate: values.identity
        ? { thumbprint: values.identity }
        : { dlib: resolve(values.dlib!), metadata: resolve(values['dlib-metadata']!) },
      timestampUrl: timestamp ? (values['timestamp-url'] ?? defaultTimestampUrl) : undefined,
    }
  }
  throw new Error(`OS code signing is not available on ${process.platform}`)
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      identity: { type: 'string' },
      keychain: { type: 'string' },
      entitlements: { type: 'string' },
      'no-timestamp': { type: 'boolean' },
      'timestamp-url': { type: 'string' },
      dlib: { type: 'string' },
      'dlib-metadata': { type: 'string' },
      format: { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
    },
  })
  const [command, ...inputs] = positionals
  if (!command) {
    console.log(usage)
    return
  }
  if (command === 'sign') {
    if (inputs.length !== 1) throw new Error(usage)
    const directory = resolve(inputs[0]!)
    const identity = signingIdentity(values, true)!
    const bundle = existsSync(resolve(directory, 'update.json'))
    if (!bundle && !existsSync(resolve(directory, 'manifest.json')))
      throw new Error(`${directory} is neither a native build output nor an update bundle`)
    const result = bundle
      ? await signBundle(directory, identity)
      : await signBuild(directory, identity)
    console.log(JSON.stringify({ signed: bundle ? 'bundle' : 'build', ...result }, null, 2))
    return
  }
  if (command === 'verify') {
    if (inputs.length === 0) throw new Error(usage)
    if (process.platform !== 'darwin' && process.platform !== 'win32')
      throw new Error(`OS code signatures are not verified on ${process.platform}`)
    const options = process.platform === 'win32' ? { signtool: findSigntool() } : {}
    const verified = []
    for (const input of inputs)
      verified.push(...(await verifyTree(input, process.platform, runCommand, options)))
    console.log(JSON.stringify({ verified }, null, 2))
    return
  }
  if (command === 'installer') {
    const format = values.format
    if (inputs.length !== 1 || !values.name || !values.out) throw new Error(usage)
    if (format !== 'dmg' && format !== 'zip' && format !== 'tar.gz')
      throw new Error('--format must be dmg, zip or tar.gz')
    const signing = signingIdentity(values, false)
    const record = await createInstaller(inputs[0]!, values.out, {
      format: format as InstallerFormat,
      name: values.name,
      ...(signing ? { signing } : {}),
    })
    console.log(JSON.stringify(record, null, 2))
    return
  }
  if (command === 'notarize') {
    if (inputs.length !== 1) throw new Error(usage)
    const record = await notarize(resolve(inputs[0]!), notaryCredentials(process.env), runCommand)
    if (record.status === 'skipped') console.log(`Notarization skipped: ${record.reason}`)
    console.log(JSON.stringify(record, null, 2))
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
