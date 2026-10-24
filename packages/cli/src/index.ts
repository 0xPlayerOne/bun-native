import { readFile } from 'node:fs/promises'
import { CONTRACT_VERSION } from '../../contracts/src/core.ts'
import { BUILD_PROFILES, PROFILE_CAPABILITY_VERSION } from '../../contracts/src/profiles.ts'
import { inspectArtifact, resolveArtifact } from '../../artifacts/src/index.ts'
import type { ResolveOptions } from '../../artifacts/src/index.ts'
export async function main(args: string[]): Promise<void> {
  if (args[0] === 'doctor') {
    console.log(
      JSON.stringify(
        {
          name: 'Bunly',
          stage: 'M4 functional acceptance',
          bun: process.versions['bun'] ?? null,
          target: `${process.platform}-${process.arch}`,
          frameworkSupport: BUILD_PROFILES.cef.adapters,
          installedRuntime: { status: 'not-probed', reason: 'No installed runtime selected' },
          qualification: { scope: 'declared-functional-profiles', releaseQualified: false },
          contractVersion: CONTRACT_VERSION,
          capabilityVersion: PROFILE_CAPABILITY_VERSION,
        },
        null,
        2
      )
    )
    return
  }
  if (
    args[0] === 'artifact' &&
    (args[1] === 'resolve' || args[1] === 'inspect') &&
    args.length === 3
  ) {
    const config = JSON.parse(await readFile(args[2]!, 'utf8')) as Omit<
      ResolveOptions,
      'signal' | 'fetcher'
    >
    const result =
      args[1] === 'inspect' ? await inspectArtifact(config) : await resolveArtifact(config)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  throw new Error(
    'Usage: bun packages/cli/src/main.ts doctor | artifact resolve|inspect <trusted-local-config.json>'
  )
}
