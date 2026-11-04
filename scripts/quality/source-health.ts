import { parseSync, Visitor, type Expression } from 'oxc-parser'
import { readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

type Edge = { target: string; names: readonly string[] | 'all' | 'named' }
type Source = { exports: Set<string>; values: Set<string>; edges: Edge[] }
type Manifest = { exports?: unknown; bin?: unknown }

const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const portable = (path: string) => path.split(sep).join('/')

async function sourceFiles(directory: string): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) paths.push(...(await sourceFiles(path)))
    else if (extensions.some((extension) => entry.name.endsWith(extension))) paths.push(path)
  }
  return paths.sort()
}

function entryPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(entryPaths)
  return []
}

function resolveSource(path: string, files: ReadonlySet<string>): string | undefined {
  const candidates = [path]
  // Match the project's bundler resolution, including JS specifiers for TS source.
  const stem = path.replace(/\.[cm]?jsx?$/, '')
  if (stem !== path) candidates.push(...extensions.map((extension) => stem + extension))
  candidates.push(...extensions.map((extension) => path + extension))
  candidates.push(...extensions.map((extension) => resolve(path, 'index' + extension)))
  return candidates.find((candidate) => files.has(candidate))
}

function inspectSource(
  filename: string,
  source: string,
  files: ReadonlySet<string>,
  root: string,
  errors: string[]
): Source {
  const label = portable(relative(root, filename))
  const result: Source = { exports: new Set(), values: new Set(), edges: [] }
  const parsed = parseSync(filename, source, { sourceType: 'module' })
  if (parsed.errors.length) {
    errors.push(...parsed.errors.map((error) => `${label}: parse error: ${error.message}`))
    return result
  }

  const edge = (specifier: string, names: Edge['names']) => {
    if (!specifier.startsWith('.')) return // Public package edges have their own boundary gate.
    const target = resolveSource(resolve(dirname(filename), specifier), files)
    if (target) result.edges.push({ target, names })
    else errors.push(`${label}: unresolved local source ${specifier}`)
  }
  for (const imported of parsed.module.staticImports) {
    const names = imported.entries.some((entry) => entry.importName.kind === 'NamespaceObject')
      ? 'all'
      : imported.entries.map((entry) =>
          entry.importName.kind === 'Default' ? 'default' : entry.importName.name!
        )
    edge(imported.moduleRequest.value, names)
  }
  for (const exported of parsed.module.staticExports) {
    for (const entry of exported.entries) {
      const name = entry.exportName.kind === 'Default' ? 'default' : entry.exportName.name
      if (name) {
        result.exports.add(name)
        if (!entry.isType) result.values.add(name)
      }
      if (entry.moduleRequest) {
        edge(
          entry.moduleRequest.value,
          entry.importName.kind === 'All'
            ? 'all'
            : entry.importName.kind === 'AllButDefault'
              ? 'named'
              : entry.importName.name
                ? [entry.importName.name]
                : []
        )
      }
    }
  }

  const load = (expression: Expression | undefined) => {
    if (expression?.type === 'Literal' && typeof expression.value === 'string')
      edge(expression.value, 'all')
    else errors.push(`${label}: non-literal module load cannot be source-audited`)
  }
  new Visitor({
    ImportExpression: (node) => load(node.source),
    TSImportType: (node) => load(node.source),
    TSExternalModuleReference: (node) => load(node.expression),
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
        const argument = node.arguments[0]
        load(argument?.type === 'SpreadElement' ? undefined : argument)
      }
    },
  }).visit(parsed.program)
  return result
}

/** Audit production package source, without counting test-only consumers as live roots. */
export async function checkSourceHealth(root: string): Promise<string[]> {
  const errors: string[] = []
  const directories = await readdir(resolve(root, 'packages'), { withFileTypes: true })
  for (const directory of directories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!directory.isDirectory()) continue
    const packageRoot = resolve(root, 'packages', directory.name)
    const label = portable(relative(root, packageRoot))
    const manifest: Manifest = await Bun.file(resolve(packageRoot, 'package.json')).json()
    const files = new Set(await sourceFiles(resolve(packageRoot, 'src')))
    const sources = new Map<string, Source>()
    for (const file of files)
      sources.set(file, inspectSource(file, await Bun.file(file).text(), files, root, errors))

    const entries = new Set<string>()
    for (const entry of [...entryPaths(manifest.exports), ...entryPaths(manifest.bin)]) {
      const target = resolveSource(resolve(packageRoot, entry), files)
      if (target) entries.add(target)
      else errors.push(`${label}/package.json: unresolved source entry ${entry}`)
    }
    if (!entries.size)
      errors.push(`${label}/package.json: no explicit source exports or bin entries`)

    const reachable = new Set<string>()
    const used = new Map<string, Set<string>>()
    const visit = (file: string): void => {
      if (reachable.has(file)) return
      reachable.add(file)
      for (const edge of sources.get(file)!.edges) {
        const names = used.get(edge.target) ?? new Set<string>()
        used.set(edge.target, names)
        const imported =
          typeof edge.names === 'string'
            ? [...sources.get(edge.target)!.exports].filter(
                (name) => edge.names === 'all' || name !== 'default'
              )
            : edge.names
        for (const name of imported) names.add(name)
        visit(edge.target)
      }
    }
    for (const entry of entries) visit(entry)
    for (const [file, source] of sources) {
      const path = portable(relative(root, file))
      if (!reachable.has(file)) {
        errors.push(`${path}: source is unreachable from package exports/bin`)
      } else if (!entries.has(file)) {
        // Types may name an exported function/class's inferred contract even without an import.
        // The compiler owns type-use analysis; this gate diagnoses unnecessary value exports.
        for (const name of source.values)
          if (!used.get(file)?.has(name)) errors.push(`${path}: unused internal export ${name}`)
      }
    }
  }
  return errors.sort()
}

if (import.meta.main) {
  const errors = await checkSourceHealth(resolve(import.meta.dir, '../..'))
  if (errors.length) {
    console.error(errors.join('\n'))
    console.error(
      'Remove stale source/exports or connect the intended public entry; rerun bun run check:health'
    )
    process.exitCode = 1
  } else console.log('Production package source reachability and internal value exports verified')
}
