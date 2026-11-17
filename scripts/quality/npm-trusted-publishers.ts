import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reports whether npm accepts this workflow's OIDC identity as the trusted
 * publisher of each @bun-native package.
 *
 * `npm publish` swallows a failed trusted-publishing exchange and reports only
 * `ENEEDAUTH`, minutes into a release and after artifacts exist (#703). npm has
 * no public endpoint that reads a package's trusted publisher, so the only way
 * to check the binding is to ask npm for the same exchange `npm publish` does:
 *
 *   POST /-/npm/v1/oidc/token/exchange/package/<escaped name>
 *   Authorization: Bearer <GitHub OIDC token for npm:registry.npmjs.org>
 *
 * The request mirrors npm's own client (npm/lib/utils/oidc.js) exactly, so an
 * HTTP 200 here means `npm publish` would authenticate for that package.
 *
 * This must run from the workflow that owns the publishers (`release.yml`):
 * npm matches the OIDC `workflow` claim against the registered filename, so a
 * probe in another workflow file can never match even when the binding is right.
 *
 *   bun scripts/quality/npm-trusted-publishers.ts --names @bun-native/core,…
 *   bun scripts/quality/npm-trusted-publishers.ts --registry-directory DIR
 *
 * Exits 1 when any package rejects this workflow, so CI surfaces the reason
 * instead of a later `ENEEDAUTH`.
 */

export type ProbeResult = {
  name: string
  /** HTTP status from the exchange, or null when the OIDC token was unavailable. */
  status: number | null
  accepted: boolean
  detail: string
}

/**
 * npm escapes a scoped name with `npm-package-arg`'s escapedName: the scope
 * separator becomes `%2f` and the leading `@` is kept. `encodeURIComponent`
 * would produce `%40scope%2Fname` instead, so it is not equivalent.
 */
export function escapePackageName(name: string): string {
  return name.replace('/', '%2f')
}

export function exchangeUrl(registry: string, name: string): string {
  return new URL(`/-/npm/v1/oidc/token/exchange/package/${escapePackageName(name)}`, registry).href
}

export function audienceFor(registry: string): string {
  return `npm:${new URL(registry).hostname}`
}

/** Classifies one exchange response; npm treats anything but 200 as "no token". */
export function classify(name: string, status: number, body: string): ProbeResult {
  return {
    name,
    status,
    accepted: status === 200,
    detail: body.trim().slice(0, 300),
  }
}

export function formatResult(result: ProbeResult): string {
  if (result.accepted)
    return `OK    ${result.name} - npm exchanged the token; the trusted publisher matches.`
  const status = result.status === null ? 'no OIDC token' : `HTTP ${result.status}`
  return `FAIL  ${result.name} - ${status}${result.detail ? ` ${result.detail}` : ''}`
}

/** The registry packages a release publishes, in publish order. */
export function registryPackages(directory: string): string[] {
  return readFileSync(join(directory, 'publish-order.txt'), 'utf8')
    .split('\n')
    .filter((short) => short.trim() !== '')
    .map((short) => JSON.parse(readFileSync(join(directory, short, 'package.json'), 'utf8')).name)
}

async function oidcToken(
  requestUrl: string,
  requestToken: string,
  audience: string
): Promise<string> {
  const url = new URL(requestUrl)
  url.searchParams.append('audience', audience)
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${requestToken}` },
  })
  if (!response.ok) throw new Error(`GitHub rejected the OIDC request with ${response.status}`)
  const payload = (await response.json()) as { value?: unknown }
  if (typeof payload.value !== 'string' || payload.value === '')
    throw new Error('GitHub returned no OIDC token value')
  return payload.value
}

export async function probe(
  names: string[],
  options: { registry: string; token: string }
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  for (const name of names) {
    const response = await fetch(exchangeUrl(options.registry, name), {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.token}` },
    })
    results.push(classify(name, response.status, await response.text()))
  }
  return results
}

function parseNames(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
}

async function main(argv: string[]): Promise<void> {
  const args = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${key} needs a value`)
    args.set(key.slice(2), value)
    index += 1
  }
  const registry = args.get('registry') ?? 'https://registry.npmjs.org/'
  const directory = args.get('registry-directory')
  const names = directory ? registryPackages(directory) : parseNames(args.get('names'))
  if (names.length === 0)
    throw new Error('Pass --names scope/a,scope/b or --registry-directory with a publish-order.txt')

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!requestUrl || !requestToken)
    throw new Error(
      'No GitHub OIDC request URL or token; this needs the id-token: write permission'
    )

  console.log(
    `Identity npm must have registered: repository ${process.env.GITHUB_REPOSITORY ?? 'unknown'}, ` +
      `workflow ${process.env.GITHUB_WORKFLOW_REF ?? 'unknown'}, no environment\n`
  )

  let token: string
  try {
    token = await oidcToken(requestUrl, requestToken, audienceFor(registry))
  } catch (error) {
    console.error(`::error::${(error as Error).message}`)
    process.exit(1)
  }

  const results = await probe(names, { registry, token })
  for (const result of results) console.log(formatResult(result))

  const rejected = results.filter((result) => !result.accepted)
  if (rejected.length === 0) return
  for (const result of rejected)
    console.error(
      `::error::${result.name} rejected this trusted publisher. Register organization or user ` +
        `'${process.env.GITHUB_REPOSITORY?.split('/')[0] ?? ''}', repository ` +
        `'${process.env.GITHUB_REPOSITORY?.split('/')[1] ?? ''}', workflow filename 'release.yml' and no ` +
        `environment on npmjs.com; see docs/releasing.md and #703.`
    )
  process.exit(1)
}

if (import.meta.main) await main(process.argv.slice(2))
