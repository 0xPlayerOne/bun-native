import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { compileApplication } from '../../experiments/aot-gpui/compile.ts'
import { buildSolid } from '../solid-build.ts'
import type { Project } from './project.ts'
import { fileDigest } from './artifact.ts'
import toolchain from '../../toolchain.json'

/**
 * Bun.build names each module in its `// path` comments relative to the process
 * working directory, so bundling from another cwd changed the module bytes. Anchor
 * it to the project for the bundle's duration; every path used here is absolute.
 */
async function inProjectDirectory<T>(project: Project, bundle: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  process.chdir(project.directory)
  try {
    return await bundle()
  } finally {
    process.chdir(previous)
  }
}

export async function bundleProject(project: Project, outdir: string): Promise<string> {
  const destination = resolve(outdir)
  return inProjectDirectory(project, () => bundleFromProject(project, destination))
}

async function bundleFromProject(project: Project, outdir: string): Promise<string> {
  if (project.framework === 'solid') return buildSolid(project.entry, outdir)
  await mkdir(outdir, { recursive: true })
  const result = await Bun.build({
    entrypoints: [project.entry],
    outdir,
    naming: 'application.js',
    target: 'bun',
    format: 'esm',
    jsx: { runtime: 'automatic', importSource: '@bun-native/react' },
    define: { 'process.env.NODE_ENV': '"production"' },
    sourcemap: 'external',
  })
  if (!result.success) throw new AggregateError(result.logs, 'React native build failed')
  return join(outdir, 'application.js')
}

export async function buildProject(
  project: Project,
  host: string,
  destination: string,
  hostProfile: 'dev' | 'release'
) {
  if (Bun.revision !== toolchain.bun.revision) throw new Error('Use the pinned Bun AOT compiler')
  const outdir = resolve(destination)
  await mkdir(outdir, { recursive: true })
  if ((await readdir(outdir)).length !== 0) throw new Error('Output directory must be empty')
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const hostFile = `bun-native-host${suffix}`
  const applicationFile = `application${suffix}`
  const originalHost = await fileDigest(host)
  const module = await bundleProject(project, join(outdir, 'development'))
  const developmentModule = await fileDigest(module)
  // Resolve the bundled host relative to the executable, independent of launch cwd.
  const launcher = join(outdir, 'launcher.ts')
  await writeFile(
    launcher,
    `import { dirname, join } from 'node:path'\nprocess.env['BUN_NATIVE_HOST'] ??= join(dirname(process.execPath), ${JSON.stringify(hostFile)})\nawait import('./development/application.js')\n`,
    { flag: 'wx' }
  )
  const compiled = compileApplication(launcher, join(outdir, applicationFile), project.directory)
  await copyFile(host, join(outdir, hostFile), constants.COPYFILE_EXCL)
  if (process.platform !== 'win32') await chmod(join(outdir, hostFile), 0o755)
  const packagedHost = await fileDigest(join(outdir, hostFile))
  if (
    originalHost.sha256 !== packagedHost.sha256 ||
    originalHost.sha256 !== (await fileDigest(host)).sha256
  )
    throw new Error('Prebuilt host changed while packaging; retry with a stable input')
  if (developmentModule.sha256 !== (await fileDigest(module)).sha256)
    throw new Error('Application module changed during AOT compilation')
  // Keep machine-local paths and wall-clock timing out of the manifest so equal
  // inputs produce an identical manifest; timing goes to a separate diagnostic.
  const { compileCommand, buildMs, ...inspected } = compiled
  await writeFile(
    join(outdir, 'build-metrics.json'),
    JSON.stringify({ schemaVersion: 1, compileMs: buildMs }, null, 2) + '\n',
    { flag: 'wx' }
  )
  const manifest = {
    schemaVersion: 1,
    ...(project.packageSet ? { packageSet: project.packageSet } : {}),
    framework: project.framework,
    entrypoint: relative(project.directory, project.entry),
    target: { os: process.platform, architecture: process.arch },
    toolchain,
    application: {
      file: applicationFile,
      ...(await fileDigest(join(outdir, applicationFile))),
      // Absolute arguments are recorded relative to this artifact directory; the
      // compiler is identified by its digest instead of its install path.
      compileCommand: compileCommand.map((argument, index) =>
        index === 0 ? 'bun' : isAbsolute(argument) ? relative(outdir, argument) : argument
      ),
      compiler: { revision: Bun.revision, executable: await fileDigest(process.execPath) },
      ...inspected,
    },
    developmentModule: { file: 'development/application.js', ...developmentModule },
    sourceMap: {
      file: 'development/application.js.map',
      ...(await fileDigest(join(outdir, 'development/application.js.map'))),
    },
    launcher: { file: 'launcher.ts', ...(await fileDigest(launcher)) },
    reproducibility: {
      deterministic: [
        applicationFile,
        hostFile,
        'development/application.js',
        'development/application.js.map',
        'launcher.ts',
        'manifest.json',
      ],
      diagnostics: ['build-metrics.json', 'compile-aot.stdout.log', 'compile-aot.stderr.log'],
    },
    host: {
      file: hostFile,
      profile: hostProfile,
      ...packagedHost,
      provenance:
        'Caller-supplied prebuilt executable. Profile is caller-declared; match the hash to native build evidence.',
    },
    launch: {
      executable: applicationFile,
      host: 'Adjacent bundled host; BUN_NATIVE_HOST can explicitly override it',
    },
    verification: {
      aotCompiledProgram: 'passed',
      jitOmission: 'passed',
      nativeRendering: 'not-run',
      osInput: 'not-run',
      teardown: 'not-run',
      signing: 'unsigned',
      installation: 'not-tested',
    },
  }
  await writeFile(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  })
  return manifest
}
