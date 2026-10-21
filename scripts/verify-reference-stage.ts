/** Independent structural verifier for built-in reference acquisition/assembly stages. */
import { readFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { referenceInstallation } from '../benchmarks/adapters/references/packages.ts'
import { referenceArtifact } from '../benchmarks/adapters/references/layout.ts'
const [name, digest] = process.argv.slice(2),
  stage = process.env['BUNLY_BENCH_STAGE'],
  nonce = process.env['BUNLY_BENCH_NONCE']
if (
  (name !== 'mirin' && name !== 'butter') ||
  !digest ||
  !nonce ||
  !/^[a-f0-9]{48}$/.test(nonce) ||
  !['cold-install', 'app-assembly'].includes(stage ?? '')
)
  throw new Error('Invalid reference verification context')
await referenceInstallation(name, process.cwd(), digest)
let evidence =
  'Exact declared package versions, installed entries and frozen lock digest checked; registry publisher provenance is a separate requirement'
if (stage === 'app-assembly') {
  const artifact = await referenceArtifact(name, process.cwd())
  const handle = await open(artifact.executable, 'r'),
    magic = Buffer.alloc(4)
  try {
    if ((await handle.read(magic)).bytesRead !== 4) throw new Error('Truncated executable')
  } finally {
    await handle.close()
  }
  const valid =
    process.platform === 'linux'
      ? magic.toString('hex') === '7f454c46'
      : process.platform === 'win32'
        ? magic.subarray(0, 2).toString() === 'MZ'
        : ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(
            magic.toString('hex')
          )
  if (!valid) throw new Error('Built executable format does not match the host platform')
  if (name === 'mirin') {
    const resources = join(
      artifact.application,
      process.platform === 'darwin' ? 'Contents/Resources' : 'resources'
    )
    const manifest = JSON.parse(await readFile(join(resources, 'mirin.manifest.json'), 'utf8')) as {
      id?: unknown
    }
    if (
      manifest.id !== 'dev.bunly.benchmark.mirin' ||
      !(await readFile(join(resources, 'worker.js'), 'utf8')).includes('initial')
    )
      throw new Error('Missing or wrong built fixture resources')
  }
  evidence =
    'Pinned dependencies, expected artifact entry, executable format and fixture resources checked; not a launch or code-signature verification'
}
console.log(
  JSON.stringify({ event: 'benchmark-verification', stage, nonce, passed: true, evidence })
)
