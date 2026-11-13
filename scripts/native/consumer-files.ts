import compilerConfig from '../../tsconfig.json'

/**
 * Files shared by every project that installs Bun Native from packages (a local
 * package set or the npm registry) instead of using a checkout's workspace.
 */

/** The installed CLI, run without auto-install so a missing package fails instead of downloading. */
export const installedCli = 'bun --no-install ./node_modules/@bun-native/cli/src/scripts/native.ts'

export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

/** The template formatter keeps short string arrays on one line, so format checks pass as generated. */
const formattedJSON = (value: unknown) =>
  json(value).replace(
    /\[\n\s*("[^"\n]*"(?:,\n\s*"[^"\n]*")*)\n\s*\]/g,
    (_, items: string) => `[${items.split(/,\n\s*/).join(', ')}]`
  )

export function consumerScripts(): Record<string, string> {
  return {
    // The persistent watch controller returns freed bundler pages promptly;
    // see docs/developer-tooling.md "Controller memory".
    dev: `MIMALLOC_PURGE_DELAY=0 ${installedCli} dev .`,
    build: `${installedCli} build .`,
    check: 'bun --no-install check --no-script --no-pretty',
    format: `${installedCli} format .`,
    'format:check': `${installedCli} format . --check`,
    lint: `${installedCli} lint .`,
  }
}

export function consumerTsconfig(
  framework: 'solid' | 'react',
  entry: string,
  exclude: string[]
): string {
  return formattedJSON({
    compilerOptions: {
      ...compilerConfig.compilerOptions,
      jsxImportSource: `@bun-native/${framework}`,
    },
    include: [entry],
    exclude,
  })
}
