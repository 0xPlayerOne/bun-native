import { parseSync } from 'oxc-parser'
import { readdir } from 'node:fs/promises'
import { resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
const allowed: Record<string, readonly string[]> = {
  contracts: [],
  client: ['contracts'],
  runtime: ['contracts'],
  artifacts: [],
  cli: ['artifacts', 'contracts'],
}
export function inspectSource(filename: string, source: string, root: string): string[] {
  const file = relative(root, filename).split(sep).join('/')
  const own = file.match(/^packages\/([^/]+)\//)?.[1]
  if (!own || !(own in allowed)) return []
  const errors: string[] = []
  const browser = own === 'client' || own === 'contracts'
  const parsed = parseSync(filename, source, { sourceType: 'module' })
  if (parsed.errors.length)
    return parsed.errors.map((error) => `${file}: parse error: ${error.message}`)
  const inspect = (specifier: string) => {
    if (specifier.startsWith('.')) {
      const target = relative(root, resolve(dirname(filename), specifier))
        .split(sep)
        .join('/')
      const pkg = target.match(/^packages\/([^/]+)\//)?.[1]
      if (!pkg || (pkg !== own && !allowed[own]!.includes(pkg)))
        errors.push(`${file}: forbidden relative import ${specifier}`)
    } else if (specifier.startsWith('@bunly/')) {
      const pkg = specifier.slice('@bunly/'.length).split('/')[0]!
      if (pkg !== own && !allowed[own]!.includes(pkg))
        errors.push(`${file}: forbidden package ${specifier}`)
    } else if (browser) errors.push(`${file}: browser package imports ${specifier}`)
  }
  function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  }
  function literal(value: unknown): string | undefined {
    const node = object(value)
    if (!node) return undefined
    if (typeof node['value'] === 'string') return node['value']
    if (node['type'] === 'TSLiteralType') return literal(node['literal'])
    return undefined
  }
  function moduleSource(value: unknown): void {
    const source = literal(value)
    if (source === undefined)
      errors.push(`${file}: non-literal module load cannot be boundary-checked`)
    else inspect(source)
  }
  let applicationEntryLoads = 0
  function trustedApplicationEntry(node: Record<string, unknown>): boolean {
    // This private isolate entry intentionally loads a trusted application's absolute path.
    // Keep the exception specific to this one expression; package imports still use the
    // ordinary checks, and browser packages never receive a dynamic-import exception.
    if (file !== 'packages/runtime/src/service-reload-runner.ts' || node['options'] != null)
      return false
    const member = object(node['source'])
    const call = object(member?.['object'])
    const callee = object(call?.['callee'])
    const property = object(member?.['property'])
    const args = call?.['arguments']
    const argument = Array.isArray(args) && args.length === 1 ? object(args[0]) : undefined
    return (
      member?.['type'] === 'MemberExpression' &&
      member['computed'] === false &&
      member['optional'] === false &&
      call?.['type'] === 'CallExpression' &&
      call['optional'] === false &&
      callee?.['type'] === 'Identifier' &&
      callee['name'] === 'pathToFileURL' &&
      argument?.['type'] === 'Identifier' &&
      argument['name'] === 'entry' &&
      property?.['type'] === 'Identifier' &&
      property['name'] === 'href'
    )
  }
  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) walk(child)
      return
    }
    const node = object(value)
    if (!node) return
    const type = node['type']
    if (
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(
        type as string
      ) &&
      node['source']
    )
      moduleSource(node['source'])
    if (type === 'ImportExpression') {
      if (trustedApplicationEntry(node)) {
        if (++applicationEntryLoads > 1)
          errors.push(`${file}: only one trusted application entry load is permitted`)
      } else moduleSource(node['source'])
    }
    if (type === 'TSImportType') moduleSource(node['source'] ?? node['argument'])
    if (type === 'TSExternalModuleReference') moduleSource(node['expression'])
    const callee = object(node['callee'])
    if (
      type === 'CallExpression' &&
      callee?.['type'] === 'Identifier' &&
      callee['name'] === 'require'
    ) {
      const args = node['arguments']
      moduleSource(Array.isArray(args) ? args[0] : undefined)
    }
    if (
      browser &&
      type === 'Identifier' &&
      ['Bun', 'process', 'require'].includes(node['name'] as string)
    )
      errors.push(`${file}: browser package uses host global ${node['name']}`)
    for (const child of Object.values(node)) if (child && typeof child === 'object') walk(child)
  }
  walk(parsed.program)
  return errors
}
async function files(dir: string): Promise<string[]> {
  const result: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'target'].includes(e.name)) continue
    const path = resolve(dir, e.name)
    if (e.isDirectory()) result.push(...(await files(path)))
    else if (/\.[mc]?tsx?$/.test(e.name)) result.push(path)
  }
  return result
}
export async function checkBoundaries(root: string): Promise<string[]> {
  const errors: string[] = []
  const sources = (await files(resolve(root, 'packages'))).sort()
  // Bound simultaneous native file reads and retain deterministic diagnostic ordering.
  for (let offset = 0; offset < sources.length; offset += 16) {
    const batch = sources.slice(offset, offset + 16)
    const texts = await Promise.all(batch.map((file) => Bun.file(file).text()))
    for (let i = 0; i < batch.length; i++) errors.push(...inspectSource(batch[i]!, texts[i]!, root))
  }
  for (const [name, deps] of Object.entries(allowed)) {
    const pkg = (await Bun.file(resolve(root, `packages/${name}/package.json`)).json()) as {
      dependencies?: Record<string, string>
    }
    for (const key of Object.keys(pkg.dependencies ?? {}))
      if (!deps.map((d) => '@bunly/' + d).includes(key))
        errors.push(`${name}: unexpected runtime dependency ${key}`)
  }
  return errors
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = await checkBoundaries(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else console.log('Workspace and browser boundaries verified')
}
