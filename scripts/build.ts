import { resolve } from 'node:path'

// Package validation build only. Production AOT is a separate, explicit command.
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, '../packages/protocol/src/index.ts')],
  outdir: resolve(import.meta.dir, '../dist/protocol'),
  target: 'bun',
  format: 'esm',
  sourcemap: 'external',
})

if (!result.success) throw new AggregateError(result.logs, 'TypeScript package build failed')
console.log('Built protocol package (JavaScript modules; not an AOT executable)')
