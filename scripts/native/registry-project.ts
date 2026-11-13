import { dirname, join } from 'node:path'
import toolchain from '../../toolchain.json'
import { consumerScripts, consumerTsconfig, installedCli, json } from './consumer-files.ts'
import type { Framework } from './bundle.ts'

/**
 * The dependencies of a project created by the npm-installed CLI: every
 * `@bun-native/*` package at the CLI's own release version, plus the framework and
 * tool pins the release was qualified with. `scripts/registry-packages.ts` derives it
 * from the package set's consumer definitions and publishes it in the CLI's
 * `package.json` under `bunNative.templates`.
 */
export type RegistryTemplate = {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}
export type RegistryTemplates = Record<Framework, RegistryTemplate>

type ConsumerPins = Record<Framework, RegistryTemplate>

/** The published templates for `version`: local `@bun-native/*` versions become the release version. */
export function registryTemplates(consumers: ConsumerPins, version: string): RegistryTemplates {
  const release = (pins: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(pins).map(([name, pin]) => [
        name,
        name.startsWith('@bun-native/') ? version : pin,
      ])
    )
  const template = (framework: Framework): RegistryTemplate => ({
    dependencies: release(consumers[framework].dependencies),
    devDependencies: release(consumers[framework].devDependencies),
  })
  return { solid: template('solid'), react: template('react') }
}

/**
 * The templates an npm-installed CLI carries, read from its own `package.json`
 * (`root` is the package's `src`). A CLI from a local package set has none.
 */
export async function installedTemplates(root: string): Promise<RegistryTemplates> {
  const manifest: { bunNative?: { templates?: RegistryTemplates } } = await Bun.file(
    join(dirname(root), 'package.json')
  ).json()
  const templates = manifest.bunNative?.templates
  if (!templates?.solid || !templates.react)
    throw new Error(
      'This CLI was not installed from the npm registry; create the project with --packages /path/to/package-set/manifest.json'
    )
  return templates
}

export function registryFiles(
  template: RegistryTemplate,
  framework: Framework,
  entry: string,
  name: string
): Record<string, string> {
  const version = template.dependencies['@bun-native/core']
  return {
    'bun-native.json': json({ schemaVersion: 1, framework, entry }),
    'package.json': json({
      name,
      private: true,
      type: 'module',
      packageManager: `bun@${toolchain.bun.version}`,
      engines: { bun: toolchain.bun.version },
      scripts: consumerScripts(),
      dependencies: template.dependencies,
      devDependencies: template.devDependencies,
    }),
    'tsconfig.json': consumerTsconfig(framework, entry, ['dist', 'node_modules', '.bun-native']),
    '.gitignore': 'dist/\n.bun-native/\nnode_modules/\n',
    'README.md': `# ${name}

This project depends on the Bun Native ${version} packages from the npm registry. Use the Bun version in \`package.json\` \`engines\` (${toolchain.bun.cliRevision}); \`bun run build\` refuses any other compiler.

1. \`bun install\` installs the pinned dependencies, including this project's own \`@bun-native/cli\`.
2. \`${installedCli} host install\` downloads the released native host for this version into \`.bun-native/hosts\` and prints its path. Released hosts exist for linux-x64, linux-arm64, darwin-arm64 and darwin-x64.

- \`bun run check\` checks TypeScript or checked JavaScript.
- \`bun run format\` applies Bun's built-in formatter in the template style unless the project supplies its own formatter config; \`bun run format:check\` only reports differences.
- \`bun run lint\` runs the CLI's pinned \`oxlint\` with the template rules unless the project supplies its own \`.oxlintrc.json\`.
- \`bun run dev --host auto\` bundles and opens the app once with the released host (or pass \`--host /absolute/path/to/bun-native-host\`). Add \`--watch\` to remount after source edits; state resets on every edit.
- \`bun run build --host auto --host-profile release\` creates an unsigned same-platform AOT app in \`dist\`. The output directory must be empty.

Keep the template's optional development IPC hooks: they report readiness and clean up the renderer and owned host before a replacement starts. The host is unsigned; see the Bun Native [getting-started guide](https://github.com/0xPlayerOne/bun-native/blob/v${version}/docs/getting-started.md) and [developer tooling](https://github.com/0xPlayerOne/bun-native/blob/v${version}/docs/developer-tooling.md).
`,
  }
}
