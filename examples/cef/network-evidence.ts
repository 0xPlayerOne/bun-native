import type { NativeEvent } from '../../packages/runtime/src/native-transport.ts'

/** Contributor receipt only; never changes navigation or certificate admission. */
export function ordinaryHttpsEvidence(
  event: NativeEvent,
  expectedUrl: string,
  record: (value: Readonly<Record<string, unknown>>) => void
): boolean {
  if (event.data?.['url'] !== expectedUrl) return false
  if (event.event === 'view.loaded') {
    const status = event.data['status']
    const valid =
      typeof status === 'number' && Number.isSafeInteger(status) && status >= 100 && status <= 599
    record({
      event: 'bunly.network.https-observation',
      schema: 1,
      kind: 'loaded',
      status: valid ? status : null,
    })
    if (!valid) throw new Error('Ordinary HTTPS returned an invalid native HTTP status')
    if (status < 200 || status >= 300) throw new Error(`Ordinary HTTPS returned HTTP ${status}`)
    return true
  }
  if (event.event === 'view.load-error') {
    const code = event.data['code']
    const valid =
      typeof code === 'number' && Number.isSafeInteger(code) && code >= -2147483648 && code < 0
    record({
      event: 'bunly.network.https-observation',
      schema: 1,
      kind: 'load-error',
      code: valid ? code : null,
    })
    throw new Error(
      valid ? `Ordinary HTTPS native load failed (${code})` : 'Ordinary HTTPS native load failed'
    )
  }
  return false
}
