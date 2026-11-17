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

export type Options = {
  registry: string
  names: string[]
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

export type Environment = {
  ACTIONS_ID_TOKEN_REQUEST_URL?: string
  ACTIONS_ID_TOKEN_REQUEST_TOKEN?: string
  GITHUB_REPOSITORY?: string
  GITHUB_WORKFLOW_REF?: string
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/**
 * npm escapes a scoped name with `npm-package-arg`'s escapedName: the scope
 * separator becomes `%2f` and the leading `@` is kept. `encodeURIComponent`
 * would produce `%40scope%2Fname` instead, so the whole name is not encoded.
 *
 * The shape is validated instead of substituting separators across the string,
 * so a malformed name can never smuggle an extra path segment into the request.
 */
export function escapePackageName(name: string): string {
  const parts = name.split('/')
  if (parts.length > 2 || parts.some((part) => part === ''))
    throw new Error(`Refusing a package name that is not scope/name: ${name}`)
  return parts.length === 2
    ? `${parts[0]}%2f${encodeURIComponent(parts[1]!)}`
    : encodeURIComponent(name)
}

export function exchangeUrl(registry: string, name: string): string {
  return new URL(`/-/npm/v1/oidc/token/exchange/package/${escapePackageName(name)}`, registry).href
}

export function audienceFor(registry: string): string {
  return `npm:${new URL(registry).hostname}`
}

/** Classifies one exchange response; npm treats anything but 200 as "no token". */
export function classify(name: string, status: number, body: string): ProbeResult {
  return { name, status, accepted: status === 200, detail: body.trim().slice(0, 300) }
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

export function parseOptions(argv: string[]): Options {
  const args = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${key} needs a value`)
    args.set(key.slice(2), value)
    index += 1
  }
  const registry = args.get('registry') ?? DEFAULT_REGISTRY
  const directory = args.get('registry-directory')
  const names = directory
    ? registryPackages(directory)
    : (args.get('names') ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '')
  if (names.length === 0)
    throw new Error('Pass --names scope/a,scope/b or --registry-directory with a publish-order.txt')
  return { registry, names }
}

async function exchangeOidcRequest(
  requestUrl: string,
  requestToken: string,
  audience: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const url = new URL(requestUrl)
  url.searchParams.append('audience', audience)
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${requestToken}` },
  })
  if (!response.ok) throw new Error(`GitHub rejected the OIDC request with ${response.status}`)
  const payload = (await response.json()) as { value?: unknown }
  if (typeof payload.value !== 'string' || payload.value === '')
    throw new Error('GitHub returned no OIDC token value')
  return payload.value
}

/** Probes every package, keeping later results even when an earlier one fails. */
export async function probe(options: Options & { token: string }): Promise<ProbeResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const results: ProbeResult[] = []
  for (const name of options.names) {
    const response = await fetchImpl(exchangeUrl(options.registry, name), {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.token}` },
    })
    results.push(classify(name, response.status, await response.text()))
  }
  return results
}

/**
 * Runs the probe and returns the process exit code, so the workflow path and
 * every failure branch stay testable without exiting the test process.
 */
export async function run(
  argv: string[],
  env: Environment = process.env as Environment,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  const options = parseOptions(argv)
  console.log(
    `Identity npm must have registered: repository ${env.GITHUB_REPOSITORY ?? 'unknown'}, ` +
      `workflow ${env.GITHUB_WORKFLOW_REF ?? 'unknown'}, no environment\n`
  )
  const oidcRequestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL
  const oidcRequestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!oidcRequestUrl || !oidcRequestToken) {
    console.error(
      '::error::No GitHub OIDC request URL or token; this job needs the id-token: write permission'
    )
    return 1
  }
  let token: string
  try {
    token = await exchangeOidcRequest(
      oidcRequestUrl,
      oidcRequestToken,
      audienceFor(options.registry),
      fetchImpl
    )
  } catch (error) {
    console.error(`::error::${(error as Error).message}`)
    return 1
  }
  const results = await probe({ ...options, token, fetchImpl })
  for (const result of results) console.log(formatResult(result))
  const rejected = results.filter((result) => !result.accepted)
  if (rejected.length === 0) return 0
  const [owner = '', repository = ''] = (env.GITHUB_REPOSITORY ?? '').split('/')
  for (const result of rejected)
    console.error(
      `::error::${result.name} rejected this trusted publisher. Register organization or user ` +
        `'${owner}', repository '${repository}', workflow filename 'release.yml' and no ` +
        `environment on npmjs.com; see docs/releasing.md and #703.`
    )
  return 1
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)))
