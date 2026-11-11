#!/usr/bin/env bun
/**
 * Read-only upstream watch for #316: does any published babel-preset-solid
 * release declare support for Babel 8?
 *
 *   bun scripts/quality/babel8-readiness.ts [--registry URL] >> "$GITHUB_STEP_SUMMARY"
 *
 * It reads the preset's dist-tags from the npm registry and checks each tagged
 * release's declared `@babel/core` peer range against a Babel 8 version. It
 * changes nothing and never fails the job on the upstream answer: a ready
 * preset is reported as a workflow notice so the #316 qualification can start.
 * It exits 1 only when the registry cannot be read or returns an unexpected
 * document, so a broken watch is visible instead of silently "not ready".
 */

const PACKAGE = 'babel-preset-solid'
/** A Babel 8 release used as the probe for each declared peer range. */
const BABEL_8_PROBE = '8.0.0'

type Packument = {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, { peerDependencies?: Record<string, string> }>
}

export type TagReport = {
  tag: string
  version: string
  babelPeer: string | null
  supportsBabel8: boolean
}

export function evaluate(packument: Packument): TagReport[] {
  const tags = packument['dist-tags']
  const versions = packument.versions
  if (!tags || !versions || Object.keys(tags).length === 0)
    throw new Error(`${PACKAGE} registry document has no dist-tags or versions`)
  return Object.entries(tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, version]) => {
      const manifest = versions[version]
      if (!manifest) throw new Error(`${PACKAGE} dist-tag ${tag} names missing version ${version}`)
      const babelPeer = manifest.peerDependencies?.['@babel/core'] ?? null
      return {
        tag,
        version,
        babelPeer,
        supportsBabel8: babelPeer !== null && Bun.semver.satisfies(BABEL_8_PROBE, babelPeer),
      }
    })
}

export function summary(reports: TagReport[]): string {
  const ready = reports.filter((report) => report.supportsBabel8)
  const lines = [
    '## Babel 8 readiness of the Solid preset (#316)',
    '',
    `Probe: \`@babel/core@${BABEL_8_PROBE}\` against each tagged \`${PACKAGE}\` peer range.`,
    '',
    '| Tag | Version | `@babel/core` peer | Babel 8 |',
    '| --- | --- | --- | --- |',
    ...reports.map(
      (r) =>
        `| ${r.tag} | ${r.version} | \`${r.babelPeer ?? 'none'}\` | ${r.supportsBabel8 ? 'yes' : 'no'} |`
    ),
    '',
    ready.length === 0
      ? 'No tagged release declares Babel 8 support. Keep the Babel 7 pins (#316 stays blocked upstream).'
      : `Babel 8 is declared by ${ready.map((r) => `${r.tag} ${r.version}`).join(', ')}. Start the #316 qualification; this watch does not qualify it.`,
  ]
  return `${lines.join('\n')}\n`
}

/** Fetches the preset document and returns the summary plus one notice per ready tag. */
export async function check(
  registry: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch
): Promise<{ summary: string; notices: string[] }> {
  const response = await fetcher(`${registry.replace(/\/$/, '')}/${PACKAGE}`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`registry returned ${response.status} for ${PACKAGE}`)
  const reports = evaluate((await response.json()) as Packument)
  return {
    summary: summary(reports),
    notices: reports
      .filter((report) => report.supportsBabel8)
      .map(
        (r) =>
          `::notice title=Babel 8 preset available (#316)::${PACKAGE}@${r.version} (${r.tag}) declares @babel/core ${r.babelPeer}`
      ),
  }
}

if (import.meta.main) {
  const flag = process.argv.indexOf('--registry')
  const registry = (flag >= 0 ? process.argv[flag + 1] : undefined) ?? 'https://registry.npmjs.org'
  try {
    const result = await check(registry)
    process.stdout.write(result.summary)
    for (const notice of result.notices) console.error(notice)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
