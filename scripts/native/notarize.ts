import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Runner } from './signing.ts'

/**
 * Apple notarization of a signed installer image (#249). Credentials come only from the
 * environment, as an App Store Connect API key or an Apple ID with an app-specific
 * password. With neither configured, notarization is skipped with a stated reason; a
 * half-configured set is an error, so a typo in a secret name never silently skips.
 */
export const apiKeyVariables = [
  'APPLE_NOTARY_KEY_ID',
  'APPLE_NOTARY_ISSUER_ID',
  'APPLE_NOTARY_PRIVATE_KEY',
] as const
export const appleIdVariables = [
  'APPLE_ID',
  'APPLE_TEAM_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
] as const

export type NotaryCredentials =
  | { kind: 'none'; reason: string }
  | { kind: 'api-key'; keyId: string; issuer: string; privateKey: string }
  | { kind: 'apple-id'; appleId: string; teamId: string; password: string }

export function notaryCredentials(env: Record<string, string | undefined>): NotaryCredentials {
  const present = (names: readonly string[]) => names.filter((name) => !!env[name])
  const sets = [apiKeyVariables, appleIdVariables]
  for (const names of sets) {
    const set = present(names)
    if (set.length > 0 && set.length < names.length)
      throw new Error(
        `Incomplete notarization credentials: set ${names.filter((name) => !env[name]).join(', ')} or unset ${set.join(', ')}`
      )
  }
  if (present(apiKeyVariables).length === apiKeyVariables.length)
    return {
      kind: 'api-key',
      keyId: env['APPLE_NOTARY_KEY_ID']!,
      issuer: env['APPLE_NOTARY_ISSUER_ID']!,
      privateKey: env['APPLE_NOTARY_PRIVATE_KEY']!,
    }
  if (present(appleIdVariables).length === appleIdVariables.length)
    return {
      kind: 'apple-id',
      appleId: env['APPLE_ID']!,
      teamId: env['APPLE_TEAM_ID']!,
      password: env['APPLE_APP_SPECIFIC_PASSWORD']!,
    }
  return {
    kind: 'none',
    reason: `no notarization credentials are configured (${apiKeyVariables.join(', ')} or ${appleIdVariables.join(', ')})`,
  }
}

export type NotarizationRecord =
  | { status: 'skipped'; file: string; reason: string }
  | {
      status: 'accepted'
      file: string
      submission: string
      credentials: 'api-key' | 'apple-id'
      stapled: true
      gatekeeper: string
    }

function check(runner: Runner, command: string[], what: string) {
  const result = runner(command)
  if (result.exitCode !== 0)
    throw new Error(`${what} failed (${result.exitCode})\n${result.stdout}${result.stderr}`)
  return result
}

/**
 * Submit, wait, staple and assess. Only images and packages can hold a stapled ticket, so
 * the file must be a `.dmg` or `.pkg` that is already signed with a Developer ID identity.
 */
export async function notarize(
  file: string,
  credentials: NotaryCredentials,
  runner: Runner
): Promise<NotarizationRecord> {
  if (credentials.kind === 'none') return { status: 'skipped', file, reason: credentials.reason }
  if (!/\.(dmg|pkg)$/.test(file)) throw new Error('Notarize a signed .dmg or .pkg')
  const work = await mkdtemp(join(tmpdir(), 'bun-native-notary-'))
  try {
    let auth: string[]
    if (credentials.kind === 'api-key') {
      const key = join(work, `AuthKey_${credentials.keyId}.p8`)
      await writeFile(key, credentials.privateKey, { flag: 'wx', mode: 0o600 })
      auth = ['--key', key, '--key-id', credentials.keyId, '--issuer', credentials.issuer]
    } else
      auth = [
        '--apple-id',
        credentials.appleId,
        '--team-id',
        credentials.teamId,
        '--password',
        credentials.password,
      ]
    const submitted = check(
      runner,
      [
        'xcrun',
        'notarytool',
        'submit',
        file,
        '--wait',
        '--timeout',
        '45m',
        '--output-format',
        'json',
        ...auth,
      ],
      'Notarization submission'
    )
    const result = JSON.parse(submitted.stdout) as { id?: string; status?: string }
    if (!result.id) throw new Error(`Notarization returned no submission id: ${submitted.stdout}`)
    if (result.status !== 'Accepted') {
      const log = runner(['xcrun', 'notarytool', 'log', result.id, ...auth])
      throw new Error(
        `Notarization ${result.id} ended as ${result.status ?? 'unknown'}\n${log.stdout}${log.stderr}`
      )
    }
    check(runner, ['xcrun', 'stapler', 'staple', file], 'Stapling')
    check(runner, ['xcrun', 'stapler', 'validate', file], 'Stapled ticket validation')
    const assessed = check(
      runner,
      [
        'spctl',
        '--assess',
        '--type',
        'open',
        '--context',
        'context:primary-signature',
        '--verbose=2',
        file,
      ],
      'Gatekeeper assessment'
    )
    const gatekeeper = (assessed.stderr + assessed.stdout).trim()
    if (!/source=Notarized Developer ID/.test(gatekeeper))
      throw new Error(`Gatekeeper did not accept a notarized Developer ID image: ${gatekeeper}`)
    return {
      status: 'accepted',
      file,
      submission: result.id,
      credentials: credentials.kind,
      stapled: true,
      gatekeeper,
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
