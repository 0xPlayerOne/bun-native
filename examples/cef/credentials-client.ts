const parameters = new URL(location.href).searchParams
const partition = parameters.get('partition')
const expected = parameters.get('expected')
try {
  if (
    !['A', 'B', 'E'].includes(String(partition)) ||
    !['present', 'empty'].includes(String(expected))
  )
    throw new Error('Invalid fixture role')
  if (Object.hasOwn(globalThis, '__bunlyRpc'))
    throw new Error('Remote fixture received a privileged bridge')
  if (document.cookie.includes('bunly_credential_fixture'))
    throw new Error('HttpOnly cookie exposed to page')
  const response = await fetch(`/probe?partition=${partition}&expected=${expected}`)
  const result = (await response.json()) as { passed?: unknown }
  if (result.passed !== true)
    throw new Error('Browser cookie header did not match the owned profile')
  console.log(`BUNLY_CREDENTIAL_BROWSER:${partition}:${expected}`)
} catch {
  console.error('BUNLY_CREDENTIAL_BROWSER_FAILED')
}
export {}
