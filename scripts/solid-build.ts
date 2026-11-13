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

if (import.meta.main) {
  const entry = process.argv[2]
  const outdir = process.argv[3]
  if (!entry || !outdir || process.argv.length !== 4 || !isAbsolute(outdir))
    throw new Error('Usage: bun scripts/solid-build.ts ENTRY ABSOLUTE_OUTPUT_DIRECTORY')
  console.log(await buildSolid(entry, outdir))
}
