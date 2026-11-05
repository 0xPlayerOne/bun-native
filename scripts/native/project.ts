import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inside } from './paths.ts'
import { readPackageSet, verifyInstalledPackages } from './package-set.ts'
import { fileDigest, type FileDigest } from './artifact.ts'
import { copyPackageSet, standaloneFiles } from './standalone.ts'

export type Framework = 'solid' | 'react'
export type Language = 'typescript' | 'javascript'
export type Project = {
  directory: string
  framework: Framework
  entry: string
  packageSet?: { source: { commit: string; tree: string }; manifest: FileDigest }
}

function template(framework: Framework, language: Language): string {
  const typed = language === 'typescript'
  const solid = framework === 'solid'
  const title = `Bun Native ${solid ? 'Solid' : 'React'}`
  return `${solid ? '' : '/** @jsxImportSource @bun-native/react */\n'}import { createApplication } from '@bun-native/core'
import { render${typed ? ', type JSX' : ''} } from '@bun-native/${framework}'
import { ${solid ? 'createSignal' : 'useState'} } from '${solid ? 'solid-js' : 'react'}'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable)
  throw new Error('Run the dev command with --host pointing to a prebuilt native host')
const application = await createApplication({ executable })
${typed ? `let view: ReturnType<typeof render> | undefined` : '/** @type {ReturnType<typeof render> | undefined} */\nlet view'}
const stopped = Promise.withResolvers${typed ? '<void>' : ''}()
const stop = () => stopped.resolve(${typed ? '' : 'undefined'})
${typed ? '' : '/** @param {unknown} message */\n'}function stopFromParent(message${typed ? ': unknown' : ''}) {
  if (
    message &&
    typeof message === 'object' &&
    'type' in message &&
    message.type === 'bun-native:stop'
  )
    stop()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
process.on('message', stopFromParent)

function App()${typed ? ': JSX.Element' : ''} {
  const [clicks, setClicks] = ${solid ? 'createSignal' : 'useState'}(0)
  return (
    <box style={{ direction: 'column', gap: 12, padding: 24 }}>
      <text text="${title}" style={{ font_size: 28 }} />
      <text text={'Clicks: ' + ${solid ? 'clicks()' : 'clicks'}} />
      <button
        text="Increment"
        style={{ width: 160, height: 44 }}
        onClick={() => {
          setClicks((value) => value + 1)
        }}
      />
    </box>
  )
}

try {
  const window = await application.openWindow({
    title: '${title}',
    width: 640,
    height: 480,
  })
  view = render(${solid ? 'App' : '<App />'}, window)
  await view.ready
  process.send?.({ type: 'bun-native:ready' })
  await Promise.race([window.closed, view.closed, stopped.promise])
} finally {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  process.off('message', stopFromParent)
  try {
    await view?.dispose()
  } finally {
    await application.shutdown()
    await application.closed
    process.send?.({
      type: 'bun-native:stopped',
      application: application.diagnostics,
      nodes: view?.diagnostics.nodes ?? 0,
    })
    if (process.connected) process.disconnect?.()
  }
}
`
}

export async function createProject(
  repository: string,
  destination: string,
  framework: Framework,
  language: Language,
  packages?: string
): Promise<string> {
  const set = packages === undefined ? undefined : await readPackageSet(packages)
  const root = await realpath(repository)
  const directory = resolve(destination)
  if (!set && !inside(root, directory))
    throw new Error('Create the project inside this Bun Native checkout')
  // Resolve existing parents before writing, so a symlink cannot escape the checkout.
  let ancestor = dirname(directory)
  let resolvedAncestor: string | undefined
  while (resolvedAncestor === undefined) {
    try {
      resolvedAncestor = await realpath(ancestor)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
  if (!set && resolvedAncestor !== root && !inside(root, resolvedAncestor))
    throw new Error('Project parent resolves outside this Bun Native checkout')
  await mkdir(dirname(directory), { recursive: true })
  const parent = await realpath(dirname(directory))
  if (!set && parent !== root && !inside(root, parent))
    throw new Error('Project parent resolves outside this Bun Native checkout')
  await mkdir(directory) // Existing directories, including empty ones, are never overwritten.
  try {
    const entry = language === 'typescript' ? 'main.tsx' : 'main.jsx'
    const cli = relative(directory, join(root, 'scripts/native.ts')).split(sep).join('/')
    const tsconfig = relative(directory, join(root, 'tsconfig.json')).split(sep).join('/')
    const files: Record<string, string> = {
      'bun-native.json': JSON.stringify({ schemaVersion: 1, framework, entry }, null, 2) + '\n',
      'package.json':
        JSON.stringify(
          {
            name: basename(directory),
            private: true,
            type: 'module',
            scripts: {
              dev: `bun ${JSON.stringify(cli)} dev .`,
              build: `bun ${JSON.stringify(cli)} build .`,
              check: 'bun check --no-script --no-pretty',
              format: `bun ${JSON.stringify(cli)} format .`,
              'format:check': `bun ${JSON.stringify(cli)} format . --check`,
            },
          },
          null,
          2
        ) + '\n',
      'tsconfig.json': `{
  "extends": ${JSON.stringify(tsconfig)},
  "compilerOptions": {
    "jsxImportSource": "@bun-native/${framework}"
  },
  "include": [${JSON.stringify(entry)}],
  "exclude": ["dist", ".bun-native"]
}
`,
      '.gitignore': 'dist/\n.bun-native/\n',
      'README.md': `# ${basename(directory)}\n\nThis project uses the surrounding Bun Native checkout and its pinned dependencies.\nRun \`bun install --frozen-lockfile\` in the checkout first; no Rust compiler is needed when you supply a prebuilt host.\n\n- \`bun run check\` checks TypeScript or checked JavaScript.\n- \`bun run format\` applies Bun's built-in formatter; \`bun run format:check\` only reports differences.\n- \`bun run dev --host /absolute/path/to/bun-native-host\` bundles and opens the app once.\n- Add \`--watch\` to remount after source edits with joined teardown. State resets on every successful edit; state-preserving hot reload is not implemented.\n- \`bun run build --host /absolute/path/to/bun-native-host --host-profile release\` creates an unsigned same-platform AOT app in \`dist\`. The output directory must be empty.\n\nKeep the template's optional development IPC hooks: they report readiness and clean up the renderer and owned host before a replacement starts. The host is supplied explicitly and never downloaded or rebuilt. See the checkout's \`docs/developer-tooling.md\` for requirements and limitations.\n`,
      [entry]: template(framework, language),
    }
    if (set) {
      Object.assign(files, standaloneFiles(set, framework, entry, basename(directory)))
      await copyPackageSet(set, directory)
    }
    for (const [name, content] of Object.entries(files))
      await writeFile(join(directory, name), content, { flag: 'wx' })
    return directory
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function readProject(repository: string, path: string): Promise<Project> {
  const root = await realpath(repository)
  const directory = await realpath(path)
  const value: unknown = await Bun.file(join(directory, 'bun-native.json')).json()
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid bun-native.json project configuration')
  const config = value as Record<string, unknown>
  if (
    Object.keys(config).some(
      (key) => !['schemaVersion', 'framework', 'entry', 'packageSet'].includes(key)
    ) ||
    config['schemaVersion'] !== 1 ||
    (config['framework'] !== 'solid' && config['framework'] !== 'react') ||
    typeof config['entry'] !== 'string' ||
    isAbsolute(config['entry']) ||
    !/\.[jt]sx?$/.test(config['entry'])
  )
    throw new Error(
      'bun-native.json requires schemaVersion 1, framework solid|react and a relative TS/JS entry'
    )
  const entry = await realpath(join(directory, config['entry']))
  if (!inside(directory, entry) || !(await stat(entry)).isFile())
    throw new Error('Project entry must be a source file inside the project')
  if (config['packageSet'] !== undefined) {
    if (typeof config['packageSet'] !== 'string' || isAbsolute(config['packageSet']))
      throw new Error('Project packageSet must be a relative manifest path inside the project')
    const manifestPath = await realpath(join(directory, config['packageSet']))
    if (!inside(directory, manifestPath))
      throw new Error('Project packageSet resolves outside the project')
    const set = await readPackageSet(manifestPath)
    await verifyInstalledPackages(
      directory,
      set.manifest,
      config['framework'],
      relative(directory, set.directory).split(sep).join('/')
    )
    return {
      directory,
      framework: config['framework'],
      entry,
      packageSet: {
        source: { commit: set.manifest.source.commit, tree: set.manifest.source.tree },
        manifest: await fileDigest(manifestPath),
      },
    }
  }
  if (!inside(root, directory)) throw new Error('Project must be inside this Bun Native checkout')
  return { directory, framework: config['framework'], entry }
}
