export { MockBackend } from './mock.ts'
export { Registry } from './registry.ts'
export * from '../../contracts/src/index.ts'
import { BunlyError, CONTRACT_VERSION } from '../../contracts/src/index.ts'
import type {
  BrowserBackend,
  SessionHandle,
  ViewHandle,
  WindowHandle,
} from '../../contracts/src/index.ts'
export interface AppConfig {
  readonly id: string
  readonly title: string
  readonly url: string
}
export interface Application {
  readonly window: WindowHandle
  readonly view: ViewHandle
  readonly session: SessionHandle
  dispose(): Promise<void>
}
export function defineApp(config: AppConfig): Readonly<AppConfig> {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(config.id) || config.id.length > 64)
    throw new BunlyError(
      'INVALID_ARGUMENT',
      'Use a reverse-domain application ID of at most 64 characters'
    )
  return Object.freeze({ ...config })
}
export async function startApp(backend: BrowserBackend, input: AppConfig): Promise<Application> {
  const config = defineApp(input)
  if (backend.descriptor.contractVersion !== CONTRACT_VERSION)
    throw new BunlyError('VERSION_MISMATCH', 'Backend contract mismatch')
  const session = await backend.createSession({ persistence: 'ephemeral', partition: config.id })
  let window: WindowHandle | undefined
  try {
    window = await backend.createWindow({
      title: config.title,
      bounds: { x: 0, y: 0, width: 960, height: 640 },
    })
    const view = await backend.createView({
      window,
      session,
      url: config.url,
      trust: { kind: 'remote' },
    })
    const handle = window
    return Object.freeze({
      window: handle,
      view,
      session,
      async dispose() {
        await backend.closeWindow(handle)
        await backend.disposeSession(session)
      },
    })
  } catch (error) {
    if (window) await backend.closeWindow(window)
    await backend.disposeSession(session)
    throw error
  }
}

export { RpcServer } from './rpc.ts'
export type { RpcContext, RpcHandlers, RpcServerOptions } from './rpc.ts'
export { RpcViewAuthority } from './rpc-authority.ts'
export type { NativeRpcFrame, RpcIdentity, RpcLease, RpcAuthorityOptions } from './rpc-authority.ts'
export { runBackendConformance, summarizeConformance } from './conformance.ts'
export type {
  ConformanceArea,
  ConformanceCheck,
  ConformanceOptions,
  ConformanceReport,
  ConformanceStatus,
} from './conformance.ts'
