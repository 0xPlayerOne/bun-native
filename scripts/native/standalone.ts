import { constants } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { consumerScripts, consumerTsconfig, json } from './consumer-files.ts'
import { seedConsumerLock } from './package-lock.ts'
import { consumerArchiveLock, readPackageSet, type ReadPackageSet } from './package-set.ts'

const packageSetPath = 'vendor/bun-native/manifest.json'

export function standaloneFiles(
  set: ReadPackageSet,
  framework: 'solid' | 'react',
  entry: string,
  name: string
): Record<string, string> {
  const consumer = set.manifest.consumers[framework]
  const localLock = consumerArchiveLock(set.manifest, framework)
  const { overrides } = localLock
  const local = (dependencies: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(dependencies).map(([name, version]) => [name, overrides[name] ?? version])
    )
  const dependencies = local(consumer.dependencies)
  const devDependencies = local(consumer.devDependencies)
  return {
    'bun-native.json': json({ schemaVersion: 1, framework, entry, packageSet: packageSetPath }),
    'package.json': json({
      name,
      private: true,
      type: 'module',
      packageManager: `bun@${set.manifest.toolchain.bun.version}`,
      engines: { bun: set.manifest.toolchain.bun.version },
      scripts: consumerScripts(),
      dependencies,
      devDependencies,
      overrides,
    }),
    'bun.lock': json(
      seedConsumerLock(consumer.lock, { name, dependencies, devDependencies }, localLock)
    ),
    'tsconfig.json': consumerTsconfig(framework, entry, [
      'dist',
      'node_modules',
      '.bun-native',
      'vendor',
    ]),
    '.gitignore': 'dist/\n.bun-native/\nnode_modules/\n',
    'README.md': `# ${name}\n\nThis standalone project carries its local Bun Native package archives in \`vendor/bun-native\`. Commit that directory with this project. Its source snapshot is \`${set.manifest.source.commit}\`; use Bun revision \`${set.manifest.toolchain.bun.revision}\`. No checkout paths or workspace links are required.\n\nThe initial \`bun.lock\` contains every selected local archive tuple with SHA-256 integrity, matching local overrides, and the exact existing external dependency graph. No local root is left unresolved. First run \`bun install --offline --ignore-scripts --linker hoisted --backend copyfile\` with a populated package cache. An empty offline cache must fail; the local archives do not contain the third-party packages. Preserve the resulting lock, then use \`bun install --offline --frozen-lockfile --ignore-scripts --linker hoisted --backend copyfile\` for subsequent installs and relocation. The CLI never installs packages implicitly.\n\n- \`bun run check\` checks TypeScript or checked JavaScript.\n- \`bun run format\` applies Bun's built-in formatter in the template style unless the project supplies its own formatter config; \`bun run format:check\` only reports differences.\n- \`bun run lint\` runs the pinned \`oxlint\` with the CLI's template rules unless the project supplies its own \`.oxlintrc.json\`. It never lints \`vendor/\`, \`dist/\`, \`.bun-native/\` or \`node_modules/\`.\n- \`bun run dev --host /absolute/path/to/bun-native-host\` bundles and opens the app once.\n- Add \`--watch\` to remount after source edits with joined teardown. State resets; state-preserving hot reload is not implemented.\n- \`bun run build --host /absolute/path/to/bun-native-host --host-profile release\` creates an unsigned same-platform AOT app in \`dist\`. The output directory must be empty.\n\nSupply a separately acquired, compatible prebuilt native host. These commands never download it or run Cargo. Keep the template's optional development IPC hooks: they report readiness and join renderer/application/host cleanup. The archives are private experimental source packages, not a signed registry release. Their checksums establish consistency with the supplied manifest; verify that manifest's origin separately.\n\nSolid uses the universal JSX transform with \`jsx: preserve\`; its \`jsx-runtime\` export supplies types, not React-style automatic JSX functions. React uses its native JSX runtime. DOM/WebView APIs and browser component libraries are unsupported. See [the source-bound tooling documentation](https://github.com/0xPlayerOne/bun-native/blob/${set.manifest.source.commit}/docs/developer-tooling.md) for the native/platform and measurement limits.\n`,
  }
}

/** Called only after the caller exclusively creates and owns the destination. */
export async function copyPackageSet(set: ReadPackageSet, directory: string): Promise<void> {
  const destination = join(directory, dirname(packageSetPath))
  await mkdir(destination, { recursive: true })
  for (const pkg of Object.values(set.manifest.packages)) {
    const path = join(destination, pkg.archive.file)
    await mkdir(dirname(path), { recursive: true })
    await copyFile(join(set.directory, pkg.archive.file), path, constants.COPYFILE_EXCL)
  }
  await writeFile(join(directory, packageSetPath), set.text, { flag: 'wx' })
  // Re-hash the owned copies to catch a changed input between validation and copy.
  await readPackageSet(join(directory, packageSetPath))
}
