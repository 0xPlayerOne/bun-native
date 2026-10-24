/** Contributor snapshot for Python's native fault driver; never launches an application. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'

const root = resolve(import.meta.dir, '..')
const input = process.argv[2]
if (process.argv.length !== 3 || !input || Bun.version !== '1.4.3')
  throw new Error('Use pinned Bun 1.4.3 and one explicit native artifact directory')
const paths = [
  'scripts/qualify-cef-faults.py',
  'scripts/cef-fault-integrity.ts',
  'scripts/cef_fault_acceptance.py',
  'scripts/observe-process.py',
  'scripts/cef_process_role.py',
  'scripts/macos_clone_cleanup.py',
  'benchmarks/lib/native-diagnostic-events.json',
  'benchmarks/lib/inventory.ts',
  'benchmarks/lib/source-identity.ts',
  'examples/cef/fault.ts',
  'examples/cef/fault-ack.ts',
  'examples/cef/rpc-fixture-service.ts',
  'examples/cef/rpc-contract.ts',
  'examples/cef/page-readiness.ts',
]
const source = sourceIdentity(root)
const hashes = Object.fromEntries(
  await Promise.all(
    paths.map(async (path) => [
      path,
      createHash('sha256')
        .update(await readFile(resolve(root, path)))
        .digest('hex'),
    ])
  )
)
const artifact = await inventory(resolve(input))
if (JSON.stringify(sourceIdentity(root)) !== JSON.stringify(source))
  throw new Error('Source changed during native fault snapshot')
console.log(JSON.stringify({ source, hashes, artifact }))
