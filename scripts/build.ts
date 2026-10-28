/** Independent Bun builds overlap; tests and measured workloads remain sequential. */
import { mkdir, copyFile, rm, readdir, lstat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { profileFor } from '../packages/contracts/src/index.ts'
import type { BuildProfileId } from '../packages/contracts/src/index.ts'
import { reportProfileResources, selectProfileArtifacts } from '../packages/artifacts/src/index.ts'
import type { ProfileArtifactCandidate } from '../packages/artifacts/src/index.ts'

export interface WorkspaceBuildOptions {
  readonly profile?: BuildProfileId
  readonly target?: string
}

export async function buildWorkspace(
  root: string,
  options: WorkspaceBuildOptions = {}
): Promise<void> {
  const profile = profileFor(options.profile ?? 'cef')
  const target = options.target ?? `${process.platform}-${process.arch}`
  // Validate before any writer mutates output; never substitute a supported platform.
  selectProfileArtifacts({ profile, target, files: [], requireBundledEngine: false })
  const manifestPath = join(root, '.bunly', 'profiles', `${profile.id}.json`)
  await rm(manifestPath, { force: true })
  const packages = ['contracts', 'client', 'runtime', 'artifacts', 'cli'] as const
  const tasks = packages.map(async (name) => {
    const outdir = join(root, `packages/${name}/dist`)
    await rm(outdir, { recursive: true, force: true })
    const result = await Bun.build({
      entrypoints: [
        join(root, `packages/${name}/src/${name === 'cli' ? 'main' : 'index'}.ts`),
        ...(name === 'runtime'
          ? [join(root, 'packages/runtime/src/service-reload-runner.ts')]
          : []),
      ],
      outdir,
      target: name === 'client' || name === 'contracts' ? 'browser' : 'bun',
      sourcemap: 'external',
    })
    if (!result.success) throw new AggregateError(result.logs, `Failed to bundle ${name}`)
  })
  tasks.push(
    (async () => {
      const outdir = join(root, 'examples/workbench/dist')
      // A deleted example asset must not survive a rebuild either.
      await rm(outdir, { recursive: true, force: true })
      await mkdir(outdir, { recursive: true })
      const results = await Promise.allSettled([
        ...(['main', 'browser'] as const).map(async (entry) => {
          const result = await Bun.build({
            entrypoints: [join(root, `examples/workbench/${entry}.ts`)],
            outdir,
            target: entry === 'main' ? 'bun' : 'browser',
            sourcemap: 'external',
          })
          if (!result.success) throw new AggregateError(result.logs, `Failed to bundle ${entry}`)
        }),
        copyFile(join(root, 'examples/workbench/index.html'), join(outdir, 'index.html')),
      ])
      const failures = results.filter((r) => r.status === 'rejected')
      if (failures.length)
        throw new AggregateError(
          failures.map((r) => r.reason),
          'Workbench build failed'
        )
    })()
  )
  // Wait for every owned writer even on failure; never return while siblings still mutate output.
  const results = await Promise.allSettled(tasks)
  const failures = results.filter((r) => r.status === 'rejected')
  if (failures.length)
    throw new AggregateError(
      failures.map((r) => r.reason),
      'Workspace build failed'
    )
  const selected = selectProfileArtifacts({
    profile,
    target,
    files: await inventory(join(root, 'examples/workbench/dist')),
    requireBundledEngine: false,
  })
  // This command creates an SDK/workbench bundle, not an installed application or installer.
  const resources = reportProfileResources(profile.id, {
    notMeasuredReasons: {
      installerBytes: 'No installer was produced by this SDK/workbench build.',
      installedBytes: 'No complete application was installed by this build.',
      externalRuntimeDownloads: 'No runtime acquisition or native launch was measured.',
      cacheBytes: 'No runtime cache was measured.',
      residentMemoryBytes: 'No native launch was performed.',
    },
  })
  await mkdir(join(root, '.bunly', 'profiles'), { recursive: true })
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schema: 1,
        scope: 'sdk-workbench-bundle',
        profile: profile.id,
        title: profile.title,
        target,
        capabilityMetadataVersion: profile.capabilityMetadata.version,
        portableCapabilities: profile.capabilityMetadata.portable,
        backendExtensions: profile.capabilityMetadata.extensions,
        prerequisites: profile.prerequisites,
        artifactPolicy: profile.artifactPolicy,
        adapters: profile.adapters,
        selection: selected,
        resources,
      },
      null,
      2
    ) + '\n'
  )
}

/** Inventory regular build outputs only; do not follow injected links. */
async function inventory(directory: string, prefix = ''): Promise<ProfileArtifactCandidate[]> {
  const files: ProfileArtifactCandidate[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const info = await lstat(path)
    if (info.isDirectory()) {
      files.push(...(await inventory(path, relative)))
    } else if (info.isFile()) {
      files.push({
        path: relative,
        size: info.size,
        kind: relative.endsWith('.js') || relative.endsWith('.html') ? 'application' : 'runtime',
      })
    } else {
      throw new Error(`Non-regular build output: ${relative}`)
    }
  }
  return files
}

if (import.meta.main) {
  const index = process.argv.indexOf('--profile')
  const profile = profileFor(index < 0 ? 'cef' : (process.argv[index + 1] ?? ''))
  await buildWorkspace(resolve(import.meta.dir, '..'), { profile: profile.id })
  console.log(
    `Built SDK, CLI, and contract workbench for ${profile.id}. No native toolchain invoked.`
  )
  console.log(
    `Profile manifest: .bunly/profiles/${profile.id}.json; not a qualified native application.`
  )
}
