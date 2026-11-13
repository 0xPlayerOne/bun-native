import { isAbsolute } from 'node:path'
import { bundleApplication } from './native/bundle.ts'

/** Build-time JSX conversion only; the generated module is shared by dev and AOT. */
export async function buildSolid(entry: string, outdir: string): Promise<string> {
  const { module } = await bundleApplication({
    framework: 'solid',
    entry,
    outdir,
    cwd: process.cwd(),
  })
  return module
}

/** `bun scripts/solid-build.ts ENTRY ABSOLUTE_OUTPUT_DIRECTORY`; returns the module path. */
export async function solidBuildCommand(args: readonly string[]): Promise<string> {
  const [entry, outdir] = args
  if (!entry || !outdir || args.length !== 2 || !isAbsolute(outdir))
    throw new Error('Usage: bun scripts/solid-build.ts ENTRY ABSOLUTE_OUTPUT_DIRECTORY')
  return buildSolid(entry, outdir)
}

if (import.meta.main) console.log(await solidBuildCommand(process.argv.slice(2)))
