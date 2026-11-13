import type { BuildConfig, BunPlugin } from 'bun'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export type Framework = 'solid' | 'react'

/**
 * The one bundler configuration for a Bun Native application module. `native dev`,
 * `native build`, the CI fixtures and the benchmarks all bundle through it, so CI
 * qualifies the bytes users build. The module is not minified: `native dev` runs it
 * as is (readable stacks), and the AOT compiler's `--production` minifies the
 * compiled program anyway.
 */
export function bundleConfig(
  framework: Framework,
  entry: string,
  outdir: string,
  plugins: BunPlugin[] = []
): BuildConfig & { outdir: string } {
  return {
    entrypoints: [entry],
    outdir,
    naming: 'application.js',
    target: 'bun',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
    sourcemap: 'external',
    metafile: true,
    plugins,
    // Solid's universal renderer is selected through the `browser` export condition;
    // React uses its automatic JSX runtime from the adapter.
    ...(framework === 'solid'
      ? { conditions: ['browser'] }
      : { jsx: { runtime: 'automatic', importSource: '@bun-native/react' } }),
  }
}

type SolidTransform = { transformSolid(source: string, filename: string): string }

/**
 * Solid's universal JSX transform as a bundler plugin. It is the Solid adapter's own
 * `@bun-native/solid/build` export, resolved from the project (or, for a checkout
 * fixture outside it, from this CLI), so Babel ships with Solid projects only.
 */
async function solidPlugin(cwd: string): Promise<BunPlugin> {
  let transform: string
  try {
    transform = Bun.resolveSync('@bun-native/solid/build', cwd)
  } catch {
    try {
      transform = Bun.resolveSync('@bun-native/solid/build', import.meta.dir)
    } catch {
      throw new Error('A Solid application needs @bun-native/solid installed in its project')
    }
  }
  const { transformSolid } = (await import(pathToFileURL(transform).href)) as SolidTransform
  return {
    name: 'solid-native-universal',
    setup(build) {
      build.onLoad({ filter: /\.[jt]sx$/ }, async ({ path }) => ({
        contents: transformSolid(await Bun.file(path).text(), path),
        loader: 'ts',
      }))
    },
  }
}

export type Bundle = {
  /** The absolute path of `application.js`; its source map is next to it. */
  module: string
  /** Every module the bundle read, relative to `cwd`, `/`-separated and sorted (from the metafile). */
  inputs: string[]
}

/**
 * Bundle one application entry into `outdir/application.js`.
 *
 * Bun.build names each module in its `// path` comments relative to the process
 * working directory, so the bundle runs with the working directory set to `cwd` (the
 * project, or the checkout for fixtures) and equal sources give equal bytes from any
 * caller directory.
 */
export async function bundleApplication(options: {
  framework: Framework
  entry: string
  outdir: string
  cwd: string
  plugins?: BunPlugin[]
}): Promise<Bundle> {
  const entry = await realpath(options.entry)
  if (!(await stat(entry)).isFile() || !/\.[jt]sx?$/.test(entry))
    throw new Error(
      `${options.framework === 'solid' ? 'Solid' : 'React'} entry must be a TypeScript/JavaScript source file`
    )
  const outdir = resolve(options.outdir)
  await mkdir(outdir, { recursive: true })
  const plugins =
    options.plugins ??
    (options.framework === 'solid' ? [await solidPlugin(options.cwd)] : undefined)
  const previous = process.cwd()
  process.chdir(options.cwd)
  let result: Awaited<ReturnType<typeof Bun.build>>
  try {
    result = await Bun.build(bundleConfig(options.framework, entry, outdir, plugins))
  } finally {
    process.chdir(previous)
  }
  if (!result.success)
    throw new AggregateError(
      result.logs,
      `${options.framework === 'solid' ? 'Solid' : 'React'} native build failed`
    )
  return {
    module: join(outdir, 'application.js'),
    inputs: Object.keys(result.metafile?.inputs ?? {})
      .map((path) => path.split(sep).join('/'))
      .sort(),
  }
}

/**
 * The modules an entry that is compiled directly (without a framework bundle) reads,
 * from the same resolution `bun compile` uses; nothing is written.
 */
export async function moduleInputs(entry: string, cwd: string): Promise<string[]> {
  const previous = process.cwd()
  process.chdir(cwd)
  let result: Awaited<ReturnType<typeof Bun.build>>
  try {
    result = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm', metafile: true })
  } finally {
    process.chdir(previous)
  }
  if (!result.success) throw new AggregateError(result.logs, `Cannot resolve ${entry}`)
  return Object.keys(result.metafile?.inputs ?? {})
    .map((path) => path.split(sep).join('/'))
    .sort()
}
