import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ServiceApplication } from '../../../packages/runtime/src/service-reload.ts'
import { revision } from './dependency.ts'
import { shared } from '../shared/value.ts'

const application: ServiceApplication = async (context) => {
  const root = process.env['BUNLY_MANAGED_ROOT']
  if (!root || !isAbsolute(root)) throw new Error('RESTART_ROOT_INVALID')
  const path = join(root, 'bunly-dev.json')
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 4096)
    throw new Error('RESTART_CONFIGURATION_INVALID')
  const bytes = await readFile(path)
  const after = await lstat(path)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    bytes.length !== before.size
  )
    throw new Error('RESTART_CONFIGURATION_CHANGED')
  const config: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).join(',') !== 'changedNativeConfiguration' ||
    Reflect.get(config, 'changedNativeConfiguration') !== true
  )
    throw new Error('RESTART_CONFIGURATION_NOT_APPLIED')
  if (Number(revision) !== 500 || Number(shared) !== 1)
    throw new Error('RESTART_DEPENDENCIES_NOT_CURRENT')
  const configurationSha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    schema: 'managed-restart:1',
    handlers: {
      readback: async () => {
        const view = JSON.parse(await context.invoke('view', 'state', 'null')) as {
          documentId: string
          url: string
        }
        const session = JSON.parse(await context.invoke('session', 'identity', 'null')) as {
          id: string
        }
        const cookies = JSON.parse(await context.invoke('session', 'cookies', 'null')) as {
          name: string
        }[]
        return JSON.stringify({
          revision,
          shared,
          configurationApplied: Reflect.get(config, 'changedNativeConfiguration') === true,
          configurationSha256,
          loginAbsent: !cookies.some((cookie) => cookie.name === 'bunly_managed_login'),
          document: view.documentId,
          url: view.url,
          session: session.id,
        })
      },
    },
  }
}
export default application
