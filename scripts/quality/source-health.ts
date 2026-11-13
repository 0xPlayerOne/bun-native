import { parseSync, Visitor, type Expression } from 'oxc-parser'
import { readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

type Edge = { target: string; names: readonly string[] | 'all' | 'star' }
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
              ? 'star'
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

function exportedNames(sources: ReadonlyMap<string, Source>): Map<string, Set<string>> {
  const visible = new Map<string, Set<string>>()
  for (const [file, source] of sources) visible.set(file, new Set(source.exports))
  // Resolve transitive star surfaces before namespace/public roots request their members.
  // Sets only grow, so cyclic barrels converge without recursive import-order dependence.
  let changed = true
  while (changed) {
    changed = false
    for (const [file, source] of sources) {
      const names = visible.get(file)!
      for (const edge of source.edges) {
        if (edge.names !== 'star') continue
        for (const name of visible.get(edge.target)!) {
          if (name === 'default' || names.has(name)) continue
          names.add(name)
          changed = true
        }
      }
    }
  }
  return visible
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

    const visible = exportedNames(sources)
    const used = new Map<string, Set<string>>()
    const pending: string[] = []
    const request = (file: string, names: Iterable<string>): void => {
      const previous = used.get(file)
      const requested = previous ?? new Set<string>()
      const size = requested.size
      for (const name of names) requested.add(name)
      used.set(file, requested)
      // Even an empty request reaches side-effect modules. Revisit a barrel when
      // a later consumer adds names; the first path through it is not exhaustive.
      if (!previous || requested.size !== size) pending.push(file)
    }
    for (const entry of entries) request(entry, visible.get(entry)!)
    for (let index = 0; index < pending.length; index += 1) {
      const file = pending[index]!
      const source = sources.get(file)!
      for (const edge of source.edges) {
        const imported =
          edge.names === 'all'
            ? visible.get(edge.target)!
            : edge.names === 'star'
              ? [...used.get(file)!].filter(
                  (name) =>
                    name !== 'default' &&
                    !source.exports.has(name) &&
                    visible.get(edge.target)!.has(name)
                )
              : edge.names
        request(edge.target, imported)
      }
    }
    for (const [file, source] of sources) {
      const path = portable(relative(root, file))
      if (!used.has(file)) {
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

/** Directories whose modules may import repository scripts; tests count as consumers. */
const scriptConsumers = ['scripts', 'tests', 'benchmarks', 'experiments', 'examples']

/**
 * Value exports of `scripts/**` that no other module imports. Scripts have many
 * entry points (package.json, workflows, Python harnesses), so this checks only
 * exports: a value used solely inside its own module should not be exported.
 */
export async function checkScriptExports(root: string): Promise<string[]> {
  const files = new Set<string>()
  for (const directory of scriptConsumers) {
    for (const file of await sourceFiles(resolve(root, directory)).catch(() => []))
      if (!file.split(sep).includes('node_modules')) files.add(file)
  }
  const scripts = resolve(root, 'scripts') + sep
  const ignored: string[] = []
  const sources = new Map<string, Source>()
  await Promise.all(
    [...files].map(async (file) => {
      const text = await Bun.file(file).text()
      // Outside scripts/, only a module that names a scripts/ path can import one.
      if (file.startsWith(scripts) || text.includes('scripts/'))
        sources.set(file, inspectSource(file, text, files, root, ignored))
    })
  )
  // Edges to modules that were not parsed cannot reach a script export.
  for (const source of sources.values())
    source.edges = source.edges.filter((edge) => sources.has(edge.target))
  const visible = exportedNames(sources)
  const imported = new Map<string, Set<string>>()
  for (const [file, source] of sources)
    for (const edge of source.edges) {
      if (edge.target === file) continue
      const names = imported.get(edge.target) ?? new Set<string>()
      for (const name of edge.names === 'all' || edge.names === 'star'
        ? visible.get(edge.target)!
        : edge.names)
        names.add(name)
      imported.set(edge.target, names)
    }
  const errors: string[] = []
  for (const [file, source] of sources) {
    if (!file.startsWith(scripts)) continue
    for (const name of source.values)
      if (!imported.get(file)?.has(name))
        errors.push(`${portable(relative(root, file))}: unused script export ${name}`)
  }
  return errors.sort()
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..')
  const errors = [...(await checkSourceHealth(root)), ...(await checkScriptExports(root))]
  if (errors.length) {
    console.error(errors.join('\n'))
    console.error(
      'Remove stale source/exports or connect the intended public entry; rerun bun run check:health'
    )
    process.exitCode = 1
  } else
    console.log(
      'Production package source reachability, internal value exports and script exports verified'
    )
}
