import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { packageNames, readPackageSet, type PackageManifest } from './native/package-set.ts'

/**
 * Turns a verified local package set (scripts/package-native.ts) into the
 * public npm packages the release workflow publishes with npm trusted
 * publishing (OIDC) and provenance. Sources, LICENSE and the source-binding
 * record are copied unchanged; only package.json and README.md change, and
 * every @bun-native package takes the workspace version so one release
 * publishes one consistent set (docs/releasing.md).
 */

export const repositoryUrl = 'git+https://github.com/0xPlayerOne/bun-native.git'

export type RegistryManifest = Omit<PackageManifest, 'private'> & {
  description: string
  repository: { type: 'git'; url: string; directory: string }
  homepage: string
  bugs: string
  publishConfig: { access: 'public'; provenance: true }
}

const descriptions: Record<string, string> = {
  '@bun-native/cli': 'Create, check, run and AOT-build Bun Native desktop applications.',
  '@bun-native/core': 'The public TypeScript API of the Bun Native desktop framework.',
  '@bun-native/protocol': 'The private native protocol shared by Bun Native packages and hosts.',
  '@bun-native/react': 'React renderer for Bun Native desktop windows.',
  '@bun-native/renderer': 'Native element tree and batching shared by Bun Native adapters.',
  '@bun-native/runtime': 'Bun Native host process lifecycle and bridge runtime.',
  '@bun-native/solid': 'SolidJS renderer for Bun Native desktop windows.',
}

export function registryManifest(manifest: PackageManifest, version: string): RegistryManifest {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`Registry version must be x.y.z: ${version}`)
  const description = descriptions[manifest.name]
  if (!description) throw new Error(`Not a Bun Native registry package: ${manifest.name}`)
  const { private: _private, dependencies, ...rest } = manifest
  const pinned: Record<string, string> = {}
  for (const [name, range] of Object.entries(dependencies ?? {}))
    pinned[name] = name.startsWith('@bun-native/') ? version : range
  const short = manifest.name.slice('@bun-native/'.length)
  return {
    ...rest,
    version,
    description,
    ...(Object.keys(pinned).length ? { dependencies: pinned } : {}),
    repository: {
      type: 'git',
      url: repositoryUrl,
      directory: short === 'cli' ? 'scripts' : `packages/${short}`,
    },
    homepage: 'https://github.com/0xPlayerOne/bun-native#readme',
    bugs: 'https://github.com/0xPlayerOne/bun-native/issues',
    publishConfig: { access: 'public', provenance: true },
  }
}

/** Dependencies before dependents, so a partial publish never names a missing version. */
export function publishOrder(manifests: Record<string, PackageManifest>): string[] {
  const order: string[] = []
  const visiting = new Set<string>()
  const visit = (name: string) => {
    if (order.includes(name)) return
    if (visiting.has(name)) throw new Error(`Package dependency cycle at ${name}`)
    visiting.add(name)
    for (const dependency of Object.keys(manifests[name]?.dependencies ?? {}))
      if (manifests[dependency]) visit(dependency)
    visiting.delete(name)
    order.push(name)
  }
  for (const name of [...packageNames].sort()) visit(name)
  return order
}

function readme(name: string, version: string, commit: string): string {
  return `# ${name}\n\n${descriptions[name]}\n\nPart of [Bun Native](https://github.com/0xPlayerOne/bun-native), an experimental developer preview. Version ${version} was built from [${commit.slice(0, 12)}](https://github.com/0xPlayerOne/bun-native/tree/${commit}) and published from GitHub Actions with npm provenance. Use the Bun revision pinned in that commit's toolchain.json. Start with the [getting-started guide](https://github.com/0xPlayerOne/bun-native/blob/${commit}/docs/getting-started.md); \`bun-native host install\` fetches the matching release host. The license notice is in LICENSE.\n`
}

async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { 'package-set': { type: 'string' }, outdir: { type: 'string' } },
  })
  const set = values['package-set']
  if (!set || !isAbsolute(set) || !values.outdir || !isAbsolute(values.outdir))
    throw new Error(
      'Usage: bun scripts/registry-packages.ts --package-set /abs/manifest.json --outdir /abs/new-directory'
    )
  // readPackageSet verifies every archive's digest and file list first.
  const { directory: setDirectory, manifest } = await readPackageSet(set)
  const root: { version: string } = JSON.parse(
    await readFile(resolve(import.meta.dir, '..', 'package.json'), 'utf8')
  )
  const manifests = Object.fromEntries(
    Object.entries(manifest.packages).map(([name, pkg]) => [name, pkg.manifest])
  )
  const order = publishOrder(manifests)
  const output = resolve(values.outdir)
  await mkdir(output) // Never adopt or overwrite an existing directory.
  for (const name of order) {
    const short = name.slice('@bun-native/'.length)
    const directory = join(output, short)
    await mkdir(directory)
    const archive = join(setDirectory, manifest.packages[name]!.archive.file)
    const tar = Bun.spawnSync(['tar', '-xzf', archive, '-C', directory, '--strip-components=1'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    })
    if (tar.exitCode !== 0) throw new Error(`Unpacking ${name} failed: ${tar.stderr}`)
    const published = registryManifest(manifests[name]!, root.version)
    await writeFile(join(directory, 'package.json'), JSON.stringify(published, null, 2) + '\n')
    await writeFile(
      join(directory, 'README.md'),
      readme(name, root.version, manifest.source.commit)
    )
  }
  await writeFile(
    join(output, 'publish-order.txt'),
    order.map((name) => name.slice('@bun-native/'.length)).join('\n') + '\n'
  )
  console.log(`Prepared ${order.length} registry packages at version ${root.version} in ${output}`)
}

if (import.meta.main) await main(process.argv.slice(2))
