import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { restartRpcLimits, restartSchema } from './restart-contract.ts'

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
// Native grants follow document readiness, so module evaluation must finish first.
async function main(): Promise<void> {
  const form = document.querySelector<HTMLInputElement>('#draft')
  const status = document.querySelector<HTMLElement>('#result')
  check(form && status, 'Missing restart fixture elements')
  const initial = {
    instance: crypto.randomUUID(),
    formEmpty: form.value === '',
    sessionAbsent: sessionStorage.getItem('bunly.managed.session') === null,
    loginAbsent: sessionStorage.getItem('bunly.managed.login') === null,
  }
  const rpc = new RpcClient(restartSchema, await waitForCefRpcTransport(), {
    limits: restartRpcLimits,
  })
  addEventListener('pagehide', () => rpc.close(), { once: true })
  try {
    check(
      initial.formEmpty && initial.sessionAbsent && initial.loginAbsent,
      'Previous in-memory browser state survived full restart unexpectedly'
    )
    const backend = await rpc.call('begin', initial)
    check(
      backend.revision === 500 &&
        backend.shared === 1 &&
        backend.configurationApplied &&
        backend.loginAbsent,
      'Restart did not apply the edited backend and configuration'
    )
    check(
      form.value === '' &&
        sessionStorage.getItem('bunly.managed.session') === null &&
        sessionStorage.getItem('bunly.managed.login') === null,
      'Restart probe changed initial browser state'
    )
    status.textContent = `New desktop: revision ${backend.revision}, shared ${backend.shared}, changed configuration applied. Previous unsaved state is absent.`
    await rpc.call('finish', {
      ...initial,
      revision: backend.revision,
      shared: backend.shared,
      configurationApplied: backend.configurationApplied,
      configurationSha256: backend.configurationSha256,
    })
  } catch (error) {
    console.error('BUNLY_MANAGED_RESTART_RENDERER_FAILED', error)
    await rpc.call('fail', 'RESTART_RENDERER_ASSERTION').catch(() => {})
    throw error
  }
}
void main().catch((error) => console.error('BUNLY_MANAGED_RESTART_STARTUP_FAILED', error))
