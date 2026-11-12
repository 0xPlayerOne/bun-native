import toolchain from '../../toolchain.json'
import { prebuiltHost } from './host.ts'
import { readProject } from './project.ts'

type Diagnosis = { name: string; status: 'ok' | 'failed' | 'skipped'; detail: string }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Report toolchain, platform, host and project compatibility without launching anything.
 * A matching host header is not proof of a Bun Native host; the runtime handshake decides that.
 */
export async function diagnose(
  repository: string,
  options: { host?: string | undefined; project?: string | undefined }
): Promise<Diagnosis[]> {
  const results: Diagnosis[] = []
  results.push(
    Bun.revision === toolchain.bun.revision
      ? { name: 'bun', status: 'ok', detail: `pinned revision ${toolchain.bun.cliRevision}` }
      : {
          name: 'bun',
          status: 'failed',
          detail: `running ${Bun.version} (${Bun.revision}); dev, build and package sets require ${toolchain.bun.cliRevision} from toolchain.json`,
        }
  )
  const target = `${process.platform}-${process.arch}`
  results.push(
    target in toolchain.bun.packages
      ? { name: 'platform', status: 'ok', detail: `${target} has a pinned Bun distribution` }
      : {
          name: 'platform',
          status: 'failed',
          detail: `${target} has no pinned Bun distribution; supported: ${Object.keys(toolchain.bun.packages).join(', ')}`,
        }
  )
  if (options.host === undefined)
    results.push({
      name: 'host',
      status: 'skipped',
      detail: 'pass --host /absolute/path/to/bun-native-host to check a prebuilt host',
    })
  else
    try {
      const host = await prebuiltHost(options.host)
      results.push({
        name: 'host',
        status: 'ok',
        detail: `${host} is a readable ${process.platform}/${process.arch} executable (protocol handshake not run)`,
      })
    } catch (error) {
      results.push({ name: 'host', status: 'failed', detail: message(error) })
    }
  if (options.project === undefined)
    results.push({ name: 'project', status: 'skipped', detail: 'pass a project directory' })
  else
    try {
      const project = await readProject(repository, options.project)
      results.push({
        name: 'project',
        status: 'ok',
        detail: `${project.framework} project ${project.directory}${project.packageSet ? ' with verified installed package set' : ' in this checkout'}`,
      })
    } catch (error) {
      results.push({ name: 'project', status: 'failed', detail: message(error) })
    }
  return results
}
