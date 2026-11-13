#!/usr/bin/env bun
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { cliContext, releaseVersion, type CliContext } from './native/context.ts'
// Command modules load lazily: --help and the light commands never pay for the
// package-set, archive and hashing modules they do not use.

const repository = resolve(import.meta.dir, '..')
const usage = (cli: string) => `Bun Native application tooling

  ${cli} create apps/my-app [--framework solid|react] [--language typescript|javascript]
  bun scripts/native.ts create /path/to/my-app --packages /path/to/package-set/manifest.json
  ${cli} dev apps/my-app --host /absolute/path/to/bun-native-host|auto [--watch]
  ${cli} build apps/my-app --host /absolute/path/to/bun-native-host|auto --host-profile dev|release [--outdir directory] [--bundle-id reverse.dns.id]
  ${cli} check apps/my-app
  ${cli} format apps/my-app [--check]
  ${cli} lint apps/my-app
  ${cli} doctor [apps/my-app] [--host /absolute/path/to/bun-native-host|auto]
  ${cli} host install [--version x.y.z] [--force]

Projects use checkout dependencies unless --packages selects a standalone local package set.
Standalone scripts use their own installed CLI. Native hosts are supplied explicitly: an absolute path,
or auto for this CLI version's released host (linux-x64, linux-arm64, darwin-arm64, darwin-x64).
dev starts once; --watch remounts the app after edits and resets state. build produces unsigned same-platform AOT artifacts.
check runs Bun's built-in type checker, formatter check and the pinned oxlint; format applies the formatter.
lint runs only the pinned oxlint, never on vendored packages or generated output.
doctor reports Bun, platform, host-header and project compatibility without launching anything.
host install and --host auto download the unsigned release host once, check it against the release's
SHA256SUMS and reuse it from the checkout's .bun-native/hosts or the user cache. No other command downloads a host; none runs Cargo.
See docs/developer-tooling.md.`

async function resolveHost(context: CliContext, value: string | undefined): Promise<string> {
  if (value !== 'auto') {
    const { prebuiltHost } = await import('./native/host.ts')
    return prebuiltHost(value)
  }
  const { installReleaseHost } = await import('./native/host-download.ts')
  return installReleaseHost({ version: releaseVersion(context), cache: context.hostCache })
}

async function main(args: string[]): Promise<void> {
  const context = await cliContext(repository)
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]!))) {
    console.log(usage(context.command))
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
    const { createProject } = await import('./native/project.ts')
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
    const { readProject } = await import('./native/project.ts')
    const project = await readProject(repository, positionals[0]!, { verification: 'stamp' })
    const { checkProject, formatProject } = await import('./native/quality.ts')
    // The steps run concurrently; their reports print in this fixed order.
    const steps =
      command === 'format'
        ? [await formatProject(project, values.check === true)]
        : (
            await Promise.all([
              command === 'check' ? checkProject(project) : [],
              // Only check and lint load the CLI's pinned oxlint; format never depends on it.
              import('./native/lint.ts').then(({ lintProject }) => lintProject(project)),
            ])
          ).flat()
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
  if (command === 'host') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: { version: { type: 'string' }, force: { type: 'boolean' } },
    })
    if (positionals.length !== 1 || positionals[0] !== 'install')
      throw new Error(`Usage: ${context.command} host install [--version x.y.z] [--force]`)
    const { installReleaseHost } = await import('./native/host-download.ts')
    const host = await installReleaseHost({
      version: releaseVersion(context, values.version),
      cache: context.hostCache,
      force: values.force === true,
    })
    console.log(host)
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
    const host = values.host === 'auto' ? await resolveHost(context, 'auto') : values.host
    const results = await diagnose(repository, { host, project: positionals[0] })
    for (const result of results)
      console.log(`${result.status.padEnd(7)} ${result.name}: ${result.detail}`)
    if (results.some((result) => result.status === 'failed')) process.exitCode = 1
    return
  }
  if (command !== 'dev' && command !== 'build')
    throw new Error(`Unknown command: ${command}\n${usage(context.command)}`)
  const options: Record<string, { type: 'string' | 'boolean' }> = { host: { type: 'string' } }
  if (command === 'build') {
    options['outdir'] = { type: 'string' }
    options['host-profile'] = { type: 'string' }
    options['bundle-id'] = { type: 'string' }
  } else options['watch'] = { type: 'boolean' }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options,
  })
  if (positionals.length !== 1) throw new Error(`${command} requires exactly one project directory`)
  const host = await resolveHost(
    context,
    typeof values['host'] === 'string' ? values['host'] : undefined
  )
  const { readProject } = await import('./native/project.ts')
  // A build always re-verifies the package set it ships; dev may reuse the stamp.
  const project = await readProject(repository, positionals[0]!, {
    verification: command === 'build' ? 'full' : 'stamp',
  })
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
    const bundleIdentifier = values['bundle-id']
    await buildProject(
      project,
      host,
      outdir,
      profile,
      typeof bundleIdentifier === 'string' ? { bundleIdentifier } : {}
    )
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
