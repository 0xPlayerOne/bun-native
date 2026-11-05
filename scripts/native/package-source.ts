import { parseSync, Visitor, type Expression } from 'oxc-parser'
import { readdir, realpath, stat } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import toolchain from '../../toolchain.json'
import { dependencyClosure, lockedPackages } from './package-lock.ts'
import { inside } from './paths.ts'
import type { Consumer, PackageManifest } from './package-set.ts'

const portable = (path: string) => path.split(sep).join('/')
const moduleName = (name: string) =>
  name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]!

async function localFile(root: string, from: string, specifier: string): Promise<string> {
  const path = resolve(dirname(from), specifier)
  const stem = path.replace(/\.[cm]?jsx?$/, '')
  for (const candidate of [
    path,
    ...(stem === path ? [] : [stem + '.ts', stem + '.tsx']),
    path + '.ts',
    path + '.tsx',
    path + '.js',
    path + '.json',
    join(path, 'index.ts'),
  ]) {
    try {
      const canonical = await realpath(candidate)
      if (!inside(root, canonical))
        throw new Error(`Package source escapes the checkout: ${specifier}`)
      if ((await stat(canonical)).isFile()) return canonical
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        !['ENOENT', 'ENOTDIR'].includes(String(error.code))
      )
        throw error
    }
  }
  throw new Error(`Unresolved package source: ${portable(relative(root, from))} -> ${specifier}`)
}

/** Static value/type/JSON and literal dynamic imports of the one existing CLI. */
export async function cliSourceClosure(
  root: string,
  entry = 'scripts/native.ts'
): Promise<{ files: string[]; external: string[] }> {
  const directory = await realpath(root)
  const pending = [await localFile(directory, join(directory, '_entry.ts'), './' + entry)]
  const files = new Set<string>()
  const external = new Set<string>()
  for (let index = 0; index < pending.length; index += 1) {
    const path = pending[index]!
    const name = portable(relative(directory, path))
    if (files.has(name)) continue
    files.add(name)
    if (path.endsWith('.json')) continue
    const source = await Bun.file(path).text()
    const parsed = parseSync(path, source, { sourceType: 'module' })
    if (parsed.errors.length)
      throw new Error(
        `Cannot inspect ${name}: ${parsed.errors.map((error) => error.message).join('; ')}`
      )
    const specifiers = new Set<string>()
    for (const imported of parsed.module.staticImports) specifiers.add(imported.moduleRequest.value)
    for (const exported of parsed.module.staticExports)
      for (const value of exported.entries)
        if (value.moduleRequest) specifiers.add(value.moduleRequest.value)
    const load = (value: Expression | undefined) => {
      if (value?.type === 'Literal' && typeof value.value === 'string') specifiers.add(value.value)
      else if (
        !(
          name === 'scripts/native.ts' &&
          value &&
          source.slice(value.start, value.end) === 'pathToFileURL(entry).href'
        )
      )
        throw new Error(`Unresolved computed package import: ${name}`)
    }
    new Visitor({
      ImportExpression: (node) => load(node.source),
      TSImportType: (node) => load(node.source),
      TSExternalModuleReference: (node) => load(node.expression),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          const first = node.arguments[0]
          load(first?.type === 'SpreadElement' ? undefined : first)
        }
      },
    }).visit(parsed.program)
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) pending.push(await localFile(directory, path, specifier))
      else if (
        !(
          specifier === 'bun' ||
          specifier.startsWith('bun:') ||
          builtinModules.includes(specifier.replace(/^node:/, ''))
        )
      )
        external.add(moduleName(specifier))
    }
  }
  return { files: [...files].sort(), external: [...external].sort() }
}

export async function librarySourceFiles(directory: string): Promise<string[]> {
  const result: string[] = []
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const filename = join(path, entry.name)
      if (entry.isDirectory()) await visit(filename)
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
        result.push(portable(relative(directory, filename)))
      else throw new Error(`Unsupported package source entry: ${filename}`)
    }
  }
  await visit(join(directory, 'src'))
  return result.sort()
}

type WorkspaceManifest = {
  name: string
  version: string
  private: boolean
  type: string
  exports: string | Record<string, string>
  dependencies?: Record<string, string>
}
type RootManifest = { version: string; devDependencies: Record<string, string> }

export async function materializedManifests(
  root: string,
  cliExternal: string[]
): Promise<Record<string, PackageManifest>> {
  const workspace: RootManifest = await Bun.file(join(root, 'package.json')).json()
  const originals: Record<string, WorkspaceManifest> = {}
  for (const directory of ['core', 'protocol', 'runtime', 'renderer', 'solid', 'react']) {
    const manifest: WorkspaceManifest = await Bun.file(
      join(root, 'packages', directory, 'package.json')
    ).json()
    if (
      manifest.name !== `@bun-native/${directory}` ||
      !manifest.private ||
      manifest.type !== 'module'
    )
      throw new Error(`Unexpected source workspace manifest: ${directory}`)
    originals[manifest.name] = manifest
  }
  const base = {
    private: true as const,
    type: 'module' as const,
    license: 'MIT' as const,
    files: ['src', 'LICENSE', 'README.md', 'bun-native-source.json'],
    engines: { bun: toolchain.bun.version },
  }
  const packages: Record<string, PackageManifest> = {}
  for (const [name, original] of Object.entries(originals)) {
    const dependencies: Record<string, string> = {}
    for (const [dependency, version] of Object.entries(original.dependencies ?? {})) {
      if (version.startsWith('workspace:')) {
        if (version !== 'workspace:*' || !originals[dependency])
          throw new Error(`Unsupported workspace edge: ${name} -> ${dependency}`)
        dependencies[dependency] = originals[dependency]!.version
      } else dependencies[dependency] = version
    }
    if (name === '@bun-native/react') {
      // Public TS exports name these declarations, so the archive carries the
      // same pinned type edges as the consumer's explicit development types.
      for (const type of ['@types/react', '@types/react-reconciler']) {
        if (!workspace.devDependencies[type])
          throw new Error(`Missing public React type dependency: ${type}`)
        dependencies[type] = workspace.devDependencies[type]!
      }
    }
    packages[name] = {
      name,
      version: original.version,
      ...base,
      exports: original.exports,
      ...(Object.keys(dependencies).length ? { dependencies } : {}),
    }
  }
  const dependencies: Record<string, string> = {}
  for (const name of cliExternal) {
    const version = workspace.devDependencies[name]
    if (!version || version.startsWith('workspace:'))
      throw new Error(`Undeclared CLI build dependency: ${name}`)
    dependencies[name] = version
  }
  packages['@bun-native/cli'] = {
    name: '@bun-native/cli',
    version: workspace.version,
    ...base,
    bin: { 'bun-native': './src/scripts/native.ts' },
    dependencies,
  }
  return packages
}

export async function consumerDefinitions(
  root: string,
  manifests: Record<string, PackageManifest>
): Promise<{ solid: Consumer; react: Consumer }> {
  const workspace: RootManifest = await Bun.file(join(root, 'package.json')).json()
  const lock = lockedPackages(Bun.JSONC.parse(await Bun.file(join(root, 'bun.lock')).text()))
  const definition = (framework: 'solid' | 'react'): Consumer => {
    const library = framework === 'solid' ? 'solid-js' : 'react'
    const dependencies = {
      '@bun-native/core': manifests['@bun-native/core']!.version,
      [`@bun-native/${framework}`]: manifests[`@bun-native/${framework}`]!.version,
      [library]: workspace.devDependencies[library]!,
    }
    const devDependencies: Record<string, string> = {
      '@bun-native/cli': manifests['@bun-native/cli']!.version,
      '@types/bun': workspace.devDependencies['@types/bun']!,
    }
    if (framework === 'react') {
      devDependencies['@types/react'] = workspace.devDependencies['@types/react']!
      devDependencies['@types/react-reconciler'] =
        workspace.devDependencies['@types/react-reconciler']!
    }
    const external: Record<string, string> = { ...manifests['@bun-native/cli']!.dependencies }
    for (const [name, version] of Object.entries({
      ...dependencies,
      ...devDependencies,
      ...manifests[`@bun-native/${framework}`]!.dependencies,
    }))
      if (!name.startsWith('@bun-native/')) external[name] = version
    return { dependencies, devDependencies, lock: dependencyClosure(lock, external) }
  }
  return { solid: definition('solid'), react: definition('react') }
}
