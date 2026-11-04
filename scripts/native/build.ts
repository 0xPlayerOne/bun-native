import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { compileApplication } from '../../experiments/aot-gpui/compile.ts'
import { buildSolid } from '../solid-build.ts'
import type { Project } from './project.ts'
import toolchain from '../../toolchain.json'

export async function prebuiltHost(path: string | undefined): Promise<string> {
  if (!path || !isAbsolute(path))
    throw new Error(
      '--host must be an absolute path to an existing prebuilt native host; this command never runs Cargo or downloads a host'
    )
  const host = await realpath(path)
  if (!(await stat(host)).isFile()) throw new Error('The prebuilt native host must be a file')
  await access(host, constants.R_OK | (process.platform === 'win32' ? 0 : constants.X_OK))
  const file = await open(host, 'r')
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    let compatible = false
    if (bytesRead === header.length) {
      if (process.platform === 'linux')
        compatible =
          header.readUInt32LE(0) === 0x464c457f &&
          header[4] === 2 &&
          header[5] === 1 &&
          header.readUInt16LE(18) === (process.arch === 'arm64' ? 183 : 62)
      else if (process.platform === 'darwin')
        compatible =
          header.readUInt32LE(0) === 0xfeedfacf &&
          header.readUInt32LE(4) === (process.arch === 'arm64' ? 0x0100000c : 0x01000007)
      else if (process.platform === 'win32' && header.subarray(0, 2).toString() === 'MZ') {
        const pe = Buffer.alloc(6)
        const read = await file.read(pe, 0, pe.length, header.readUInt32LE(60))
        compatible =
          read.bytesRead === pe.length &&
          pe.readUInt32LE(0) === 0x00004550 &&
          pe.readUInt16LE(4) === (process.arch === 'arm64' ? 0xaa64 : 0x8664)
      }
    }
    if (!compatible)
      throw new Error(`Prebuilt host must be a ${process.platform}/${process.arch} executable`)
  } finally {
    await file.close()
  }
  return host
}

export async function bundleProject(project: Project, outdir: string): Promise<string> {
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

async function artifact(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { bytes: (await stat(path)).size, sha256: hash.digest('hex') }
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
  const originalHost = await artifact(host)
  const module = await bundleProject(project, join(outdir, 'development'))
  const developmentModule = await artifact(module)
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
  const packagedHost = await artifact(join(outdir, hostFile))
  if (
    originalHost.sha256 !== packagedHost.sha256 ||
    originalHost.sha256 !== (await artifact(host)).sha256
  )
    throw new Error('Prebuilt host changed while packaging; retry with a stable input')
  if (developmentModule.sha256 !== (await artifact(module)).sha256)
    throw new Error('Application module changed during AOT compilation')
  const manifest = {
    schemaVersion: 1,
    framework: project.framework,
    entrypoint: relative(project.directory, project.entry),
    target: { os: process.platform, architecture: process.arch },
    toolchain,
    application: {
      file: applicationFile,
      ...(await artifact(join(outdir, applicationFile))),
      ...compiled,
    },
    developmentModule: { file: 'development/application.js', ...developmentModule },
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
