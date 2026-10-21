/** Event-driven CSP proof for the public fixture, not a native permission API. */
export function observePolicyViolations(target, timeoutMs = 10000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new Error('Invalid policy observation deadline')
  }
  const remaining = new Set(['connect-src', 'frame-src'])
  let settled = false
  let timer
  let resolve
  let reject
  const completion = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  void completion.catch(() => {})
  const cleanup = () => {
    clearTimeout(timer)
    target.removeEventListener('securitypolicyviolation', listener)
  }
  const finish = (error) => {
    if (settled) return
    settled = true
    cleanup()
    if (error) reject(error)
    else resolve()
  }
  const listener = (event) => {
    let origin
    try {
      origin = new URL(event.blockedURI).origin
    } catch {
      return
    }
    if (origin !== 'https://blocked.invalid') return
    const directive = String(event.effectiveDirective || event.violatedDirective).split(' ')[0]
    remaining.delete(directive)
    if (remaining.size === 0) finish()
  }
  target.addEventListener('securitypolicyviolation', listener)
  timer = setTimeout(
    () => finish(new Error('Missing CSP violation evidence: ' + [...remaining].join(', '))),
    timeoutMs
  )
  return Object.freeze({ completion, dispose: () => finish(new Error('CSP observation disposed')) })
}
