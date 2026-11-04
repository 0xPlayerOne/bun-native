import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { buildProject, bundleProject, prebuiltHost } from './native/build.ts'
import { createProject, readProject } from './native/project.ts'
import { watchProject } from './native/watch.ts'

const repository = resolve(import.meta.dir, '..')
const usage = `Bun Native checkout tooling

  bun run native create apps/my-app [--framework solid|react] [--language typescript|javascript]
  bun run native dev apps/my-app --host /absolute/path/to/bun-native-host [--watch]
  bun run native build apps/my-app --host /absolute/path/to/bun-native-host --host-profile dev|release [--outdir directory]

Projects use the checkout's installed dependencies. Native hosts must be supplied explicitly.
dev starts once; --watch remounts the app after edits and resets state. build produces unsigned same-platform AOT artifacts.
No command downloads a host or runs Cargo. See docs/developer-tooling.md.`

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]!))) {
    console.log(usage)
    return
  }
  const [command, ...rest] = args
  if (command === 'create') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        framework: { type: 'string', default: 'solid' },
        language: { type: 'string', default: 'typescript' },
      },
    })
    if (positionals.length !== 1)
      throw new Error('create requires exactly one new project directory')
    if (values.framework !== 'solid' && values.framework !== 'react')
      throw new Error('--framework must be solid or react')
    if (values.language !== 'typescript' && values.language !== 'javascript')
      throw new Error('--language must be typescript or javascript')
    const path = await createProject(repository, positionals[0]!, values.framework, values.language)
    console.log(`Created ${values.framework} ${values.language} project: ${path}`)
    console.log('Run its check script, then dev with --host pointing to a prebuilt native host.')
    return
  }
  if (command !== 'dev' && command !== 'build')
    throw new Error(`Unknown command: ${command}\n${usage}`)
  const options: Record<string, { type: 'string' | 'boolean' }> = { host: { type: 'string' } }
  if (command === 'build') {
    options['outdir'] = { type: 'string' }
    options['host-profile'] = { type: 'string' }
  } else options['watch'] = { type: 'boolean' }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options,
  })
  if (positionals.length !== 1) throw new Error(`${command} requires exactly one project directory`)
  const host = await prebuiltHost(typeof values['host'] === 'string' ? values['host'] : undefined)
  const project = await readProject(repository, positionals[0]!)
  if (command === 'dev' && values.watch) {
    await watchProject(repository, project.directory, host)
    return
  }
  if (command === 'build') {
    const profile = values['host-profile']
    if (profile !== 'dev' && profile !== 'release')
      throw new Error(
        'build requires --host-profile dev or release (declared provenance, not a verified build profile)'
      )
    const outdir = resolve(
      typeof values.outdir === 'string' ? values.outdir : join(project.directory, 'dist')
    )
    await buildProject(project, host, outdir, profile)
    console.log(`Built unsigned AOT application and supplied host in ${outdir}`)
    return
  }
  const cache = join(project.directory, '.bun-native')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'dev-'))
  const originalHost = process.env['BUN_NATIVE_HOST']
  try {
    const entry = await bundleProject(project, directory)
    process.env['BUN_NATIVE_HOST'] = host
    console.log(`Starting ${project.framework} application with prebuilt host ${host}`)
    await import(pathToFileURL(entry).href)
  } finally {
    if (originalHost === undefined) delete process.env['BUN_NATIVE_HOST']
    else process.env['BUN_NATIVE_HOST'] = originalHost
    await rm(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    if (error instanceof AggregateError) for (const detail of error.errors) console.error(detail)
    process.exitCode = 1
  }
}
