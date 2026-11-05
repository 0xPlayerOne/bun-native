import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Required shared inputs for the core, Solid and React workload manifests. */
export async function sharedWorkloadSources(source: string) {
  return Promise.all(
    [
      'benchmarks/solid/collection.ts',
      'benchmarks/solid/ownership.ts',
      'benchmarks/solid/sources.ts',
      'benchmarks/solid/workload.ts',
    ].map(async (path) => {
      // Required files are explicit: deleting an imported helper must fail the
      // snapshot instead of silently shrinking a glob's claimed source set.
      const data = await readFile(join(source, path))
      return {
        path,
        bytes: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
      }
    })
  )
}
