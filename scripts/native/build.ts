import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { compileApplication } from './compile.ts'
import type { Project } from './project.ts'
import { bundleApplication } from './bundle.ts'
import { cachedFileDigest, fileDigest, sha256 } from './artifact.ts'
import { userCache } from './context.ts'
import toolchain from '../../toolchain.json'

/** Bundle a project's entry into `outdir/application.js` with the shared configuration. */
export async function bundleProject(project: Project, outdir: string): Promise<string> {
  const { module } = await bundleApplication({
    framework: project.framework,
    entry: project.entry,
    outdir,
    cwd: project.directory,
  })
  return module
}

/** The application bundle that holds the host in a macOS build. */
export const MACOS_HOST_BUNDLE = 'BunNativeHost.app'
const BUNDLE_IDENTIFIER = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

const xml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The Info.plist that makes the macOS host an application bundle with an identifier. */
export function hostInfoPlist(identifier: string, name: string, executable: string): string {
  if (!BUNDLE_IDENTIFIER.test(identifier))
    throw new Error(`Bundle identifier ${JSON.stringify(identifier)} is not reverse-DNS text`)
  const entry = (key: string, value: string) =>
    `  <key>${key}</key>\n  <string>${xml(value)}</string>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    entry('CFBundleIdentifier', identifier),
    entry('CFBundleExecutable', executable),
    entry('CFBundleName', name),
    entry('CFBundleDisplayName', name),
    entry('CFBundlePackageType', 'APPL'),
    entry('CFBundleInfoDictionaryVersion', '6.0'),
    entry('CFBundleShortVersionString', '1.0'),
    entry('CFBundleVersion', '1'),
    '  <key>NSHighResolutionCapable</key>\n  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/**
 * Where the host goes in a build. macOS user notifications serve only a process
 * that runs from an application bundle with an identifier
 * (docs/decisions/0009-native-notifications.md), so a macOS build puts the host in
 * `BunNativeHost.app/Contents/MacOS` next to its Info.plist; every other platform
 * keeps it adjacent to the application.
 */
export function hostLayout(
  platform: NodeJS.Platform,
  hostFile: string
): { file: string; infoPlist?: string } {
  if (platform !== 'darwin') return { file: hostFile }
  return {
    file: `${MACOS_HOST_BUNDLE}/Contents/MacOS/${hostFile}`,
    infoPlist: `${MACOS_HOST_BUNDLE}/Contents/Info.plist`,
  }
}

/** The default bundle identity: the project's package name under `dev.bun-native.app`. */
export async function defaultBundleIdentity(
  project: Project
): Promise<{ identifier: string; name: string }> {
  let name = 'application'
  try {
    const value = JSON.parse(await readFile(join(project.directory, 'package.json'), 'utf8')) as {
      name?: unknown
    }
    if (typeof value.name === 'string' && value.name) name = value.name
  } catch {}
  const slug =
    name
      .replace(/^@/, '')
      .replace(/[^A-Za-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'application'
  return { identifier: `dev.bun-native.app.${slug}`, name }
}

export async function buildProject(
  project: Project,
  host: string,
  destination: string,
  hostProfile: 'dev' | 'release',
  options: { bundleIdentifier?: string } = {}
) {
  if (Bun.revision !== toolchain.bun.revision) throw new Error('Use the pinned Bun AOT compiler')
  const outdir = resolve(destination)
  await mkdir(outdir, { recursive: true })
  if ((await readdir(outdir)).length !== 0) throw new Error('Output directory must be empty')
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const layout = hostLayout(process.platform, `bun-native-host${suffix}`)
  const hostFile = layout.file
  const identity = await defaultBundleIdentity(project)
  if (options.bundleIdentifier !== undefined) identity.identifier = options.bundleIdentifier
  // Validate before any output exists.
  const infoPlist = layout.infoPlist
    ? hostInfoPlist(identity.identifier, identity.name, `bun-native-host${suffix}`)
    : undefined
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
  // The compiler names the program by its path relative to its working directory,
  // so compiling the relative launcher from the output directory keeps the
  // executable independent of where that directory is.
  const compiled = compileApplication('launcher.ts', join(outdir, applicationFile), outdir)
  if (layout.infoPlist && infoPlist) {
    await mkdir(dirname(join(outdir, hostFile)), { recursive: true })
    await writeFile(join(outdir, layout.infoPlist), infoPlist, { flag: 'wx' })
  }
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
  const { compileCommand, buildMs, executable, ...inspected } = compiled
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
      ...executable,
      // Absolute arguments are recorded relative to this artifact directory; the
      // compiler is identified by its digest instead of its install path.
      compileCommand: compileCommand.map((argument, index) =>
        index === 0 ? 'bun' : isAbsolute(argument) ? relative(outdir, argument) : argument
      ),
      compiler: {
        revision: Bun.revision,
        executable: await cachedFileDigest(
          process.execPath,
          join(userCache(), 'compiler', `${sha256(process.execPath).slice(0, 32)}.json`)
        ),
      },
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
        ...(layout.infoPlist ? [layout.infoPlist] : []),
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
      ...(layout.infoPlist
        ? {
            bundle: {
              directory: MACOS_HOST_BUNDLE,
              identifier: identity.identifier,
              infoPlist: {
                file: layout.infoPlist,
                ...(await fileDigest(join(outdir, layout.infoPlist))),
              },
            },
          }
        : {}),
      provenance:
        'Caller-supplied prebuilt executable. Profile is caller-declared; match the hash to native build evidence.',
    },
    launch: {
      executable: applicationFile,
      host:
        process.platform === 'darwin'
          ? 'Bundled host inside BunNativeHost.app, so macOS serves it user notifications; BUN_NATIVE_HOST can explicitly override it'
          : 'Adjacent bundled host; BUN_NATIVE_HOST can explicitly override it',
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
