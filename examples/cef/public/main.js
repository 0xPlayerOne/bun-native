import { observePolicyViolations } from './nested/policy-violations.mjs'
const check = (condition, message) => {
  if (!condition) throw new Error(message)
}
try {
  const response = await fetch('/next.html', { cache: 'no-store' })
  check(
    response.ok && (await response.text()).includes('Navigation complete'),
    'Packaged fetch failed'
  )
  check(response.headers.get('content-type')?.includes('text/html'), 'MIME failed')
  check(
    response.headers.get('content-security-policy')?.includes("default-src 'none'"),
    'CSP missing'
  )
  check(response.headers.get('x-content-type-options') === 'nosniff', 'nosniff missing')
  const etag = response.headers.get('etag')
  check(etag, 'Missing asset identity')
  const conditional = await fetch('/next.html', {
    cache: 'no-store',
    headers: { 'If-None-Match': etag },
  })
  check(
    conditional.status === 304 && (await conditional.arrayBuffer()).byteLength === 0,
    'Conditional response failed'
  )
  const head = await fetch('/next.html', { method: 'HEAD', cache: 'no-store' })
  check(head.status === 200 && (await head.arrayBuffer()).byteLength === 0, 'HEAD response failed')
  const range = await fetch('/next.html', {
    cache: 'no-store',
    headers: { Range: 'bytes=0-14', 'If-Range': etag },
  })
  check(
    range.status === 206 && (await range.arrayBuffer()).byteLength === 15,
    'Range response failed'
  )
  const stale = await fetch('/next.html', {
    cache: 'no-store',
    headers: { Range: 'bytes=0-14', 'If-Range': '"stale"' },
  })
  check(
    stale.status === 200 && (await stale.arrayBuffer()).byteLength > 15,
    'If-Range fallback failed'
  )
  // CEF may surface ERR_REQUEST_RANGE_NOT_SATISFIABLE as a rejected fetch.
  // The native handler's exact 416/header contract is separately unit-tested.
  const invalidRange = await fetch('/next.html', {
    cache: 'no-store',
    headers: { Range: 'bytes=99999999-' },
  }).then(
    (result) => ({ status: result.status, rejected: false }),
    (error) => {
      if (!(error instanceof TypeError)) throw error
      return { status: null, rejected: true }
    }
  )
  check(invalidRange.status === 416 || invalidRange.rejected, 'Unsatisfiable range not rejected')
  check(
    (await fetch('/next.html', { cache: 'no-store' })).ok,
    'Resource must remain usable after range rejection'
  )
  console.log('BUNLY_RANGE_REJECTION:' + JSON.stringify(invalidRange))
  for (const path of [
    '/not-in-public-manifest',
    '/assets.json',
    '/runtime.json',
    '/backend/main.js',
    '/.env',
    '/%252e%252e/backend/main.js',
  ]) {
    const denied = await fetch(path, { cache: 'no-store' })
    check([400, 403, 404].includes(denied.status), 'Unintended public resource: ' + path)
  }
  const module = await import('./nested/module.mjs')
  check(module.answer === 42, 'Nested module failed')
  check(
    (await (await fetch('/nested/unicode-%C3%A9.txt')).text()) === 'Bunly unicode asset\n',
    'Unicode public resource failed'
  )
  const frame = document.createElement('iframe')
  await new Promise((resolve, reject) => {
    frame.onload = resolve
    frame.onerror = () => reject(new Error('Packaged frame load failed'))
    frame.src = '/next.html'
    document.body.append(frame)
  })
  check(frame.contentDocument?.title === 'Navigation complete', 'Same-origin frame unavailable')
  frame.remove()
  check(
    typeof globalThis.Bun === 'undefined' &&
      typeof globalThis.process === 'undefined' &&
      typeof globalThis.require === 'undefined' &&
      typeof globalThis.bunly === 'undefined',
    'Native authority leaked to page'
  )
  const policy = observePolicyViolations(document)
  const foreign = document.createElement('iframe')
  try {
    await fetch('https://blocked.invalid/').then(
      () => {
        throw new Error('Remote fetch escaped CSP')
      },
      (error) => check(error instanceof TypeError, 'Remote fetch failed for an unexpected reason')
    )
    foreign.src = 'https://blocked.invalid/'
    document.body.append(foreign)
    await policy.completion
  } finally {
    foreign.remove()
    policy.dispose()
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  console.log('BUNLY_ASSET_TEST_OK')
} catch (error) {
  console.error('BUNLY_ASSET_TEST_FAILED: ' + (error?.stack || String(error)))
}
