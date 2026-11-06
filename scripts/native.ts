#!/usr/bin/env bun
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { prebuiltHost } from './native/host.ts'
import { createProject, readProject } from './native/project.ts'

const repository = resolve(import.meta.dir, '..')
const usage = `Bun Native application tooling

  bun run native create apps/my-app [--framework solid|react] [--language typescript|javascript]
  bun scripts/native.ts create /path/to/my-app --packages /path/to/package-set/manifest.json
  bun run native dev apps/my-app --host /absolute/path/to/bun-native-host [--watch]
  bun run native build apps/my-app --host /absolute/path/to/bun-native-host --host-profile dev|release [--outdir directory]
  bun run native check apps/my-app
  bun run native format apps/my-app [--check]
  bun run native lint apps/my-app
  bun run native doctor [apps/my-app] [--host /absolute/path/to/bun-native-host]

Projects use checkout dependencies unless --packages selects a standalone local package set.
Standalone scripts use their own installed CLI. Native hosts must be supplied explicitly.
dev starts once; --watch remounts the app after edits and resets state. build produces unsigned same-platform AOT artifacts.
check runs Bun's built-in type checker, formatter check and the pinned oxlint; format applies the formatter.
lint runs only the pinned oxlint, never on vendored packages or generated output.
doctor reports Bun, platform, host-header and project compatibility without launching anything.
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
        packages: { type: 'string' },
      },
    })
    if (positionals.length !== 1)
      throw new Error('create requires exactly one new project directory')
    if (values.framework !== 'solid' && values.framework !== 'react')
      throw new Error('--framework must be solid or react')
    if (values.language !== 'typescript' && values.language !== 'javascript')
      throw new Error('--language must be typescript or javascript')
    const path = await createProject(
      repository,
      positionals[0]!,
      values.framework,
      values.language,
      values.packages
    )
    console.log(`Created ${values.framework} ${values.language} project: ${path}`)
    console.log(
      values.packages
        ? 'Follow the generated README to install the pinned dependencies, then run check and dev with a prebuilt host.'
        : 'Run its check script, then dev with --host pointing to a prebuilt native host.'
    )
    return
  }
  if (command === 'check' || command === 'format' || command === 'lint') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: command === 'format' ? { check: { type: 'boolean' } } : {},
    })
    if (positionals.length !== 1)
      throw new Error(`${command} requires exactly one project directory`)
    const project = await readProject(repository, positionals[0]!)
    const { checkProject, formatProject } = await import('./native/quality.ts')
    const steps = []
    if (command === 'format') steps.push(formatProject(project, values.check === true))
    else {
      if (command === 'check') steps.push(...checkProject(project))
      // Only check and lint load the CLI's pinned oxlint; format never depends on it.
      const { lintProject } = await import('./native/lint.ts')
      steps.push(lintProject(project))
    }
    for (const step of steps) {
      if (step.output) console.log(step.output)
      console.log(`${step.name}: ${step.exitCode === 0 ? 'passed' : 'failed'}`)
    }
    if (steps.some((step) => step.exitCode !== 0)) {
      const formatting = steps.find((step) => step.name === 'format')
      if (formatting && formatting.exitCode !== 0 && (command === 'check' || values.check === true))
        console.error(
          'Apply formatting with the project format script or the native format command.'
        )
      process.exitCode = 1
    }
    return
  }
  if (command === 'doctor') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: { host: { type: 'string' } },
    })
    if (positionals.length > 1) throw new Error('doctor accepts at most one project directory')
    const { diagnose } = await import('./native/doctor.ts')
    const results = await diagnose(repository, { host: values.host, project: positionals[0] })
    for (const result of results)
      console.log(`${result.status.padEnd(7)} ${result.name}: ${result.detail}`)
    if (results.some((result) => result.status === 'failed')) process.exitCode = 1
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
    const { watchProject } = await import('./native/watch.ts')
    await watchProject(repository, project.directory, host)
    return
  }
  const { buildProject, bundleProject } = await import('./native/build.ts')
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
