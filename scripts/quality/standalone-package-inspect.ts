import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// The owning harness copies these exact bytes outside the source checkout. It
// validates the installed CLI's file inventory before starting this inspector.
const [directory, mode] = process.argv.slice(2)
if (!directory || !isAbsolute(directory) || !['lock', 'imports'].includes(mode ?? ''))
  throw new Error('Usage: standalone-package-inspect.ts ABSOLUTE_PROJECT lock|imports')
const project = await realpath(directory)
const cli = await realpath(join(project, 'node_modules/@bun-native/cli/src'))
const contained = (path: string) => {
  const local = relative(project, path)
  return local !== '' && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
}
if (!contained(cli)) throw new Error('Inspector CLI resolves outside the consumer')
const { readProject } = await import(pathToFileURL(join(cli, 'scripts/native/project.ts')).href)
const { verifyConsumerLock } = await import(
  pathToFileURL(join(cli, 'scripts/native/package-lock.ts')).href
)
const { requiredPackages, consumerArchiveLock } = await import(
  pathToFileURL(join(cli, 'scripts/native/package-set.ts')).href
)
const validated = await readProject(cli, project)
const set = await Bun.file(join(project, 'vendor/bun-native/manifest.json')).json()
verifyConsumerLock(
  Bun.JSONC.parse(await Bun.file(join(project, 'bun.lock')).text()),
  set.consumers[validated.framework].lock,
  false,
  consumerArchiveLock(set, validated.framework)
)
const imports: { specifier: string; resolved: string; exports: string[] }[] = []
if (mode === 'imports') {
  for (const name of requiredPackages(set, validated.framework)) {
    if (name === '@bun-native/cli') continue
    const exported = set.packages[name].manifest.exports
    const subpaths = typeof exported === 'string' ? ['.'] : Object.keys(exported)
    for (const subpath of subpaths) {
      const specifier = name + (subpath === '.' ? '' : subpath.slice(1))
      const resolved = await realpath(Bun.resolveSync(specifier, project))
      if (!contained(resolved)) throw new Error(`Public export escapes the consumer: ${specifier}`)
      const module = await import(pathToFileURL(resolved).href)
      imports.push({
        specifier,
        resolved: relative(project, resolved),
        exports: Object.keys(module).sort(),
      })
    }
  }
}
console.log(
  JSON.stringify({
    status: 'passed',
    mode,
    framework: validated.framework,
    source: validated.packageSet.source,
    requiredPackages: requiredPackages(set, validated.framework),
    externalLock: 'exact source tuple and nested locator equality',
    imports,
    scope: 'Public modules only; this inspector invokes no application or window API',
  })
)
