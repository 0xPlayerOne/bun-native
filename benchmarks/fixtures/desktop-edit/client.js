// Shared by actual desktop adapters. No backend or filesystem capability is exposed.
const fragment = new URLSearchParams(location.hash.slice(1))
const token = fragment.get('token')
if (!token || !/^[a-f0-9]{48}$/.test(token)) throw new Error('Missing fixture credential')
history.replaceState(null, '', '/')
const headers = { 'x-bunly-probe-token': token, 'content-type': 'application/json' }
const response = await fetch('/descriptor', { headers, signal: AbortSignal.timeout(10000) })
if (!response.ok) throw new Error('No registered fixture host')
const descriptor = await response.json()
const documentId = crypto.randomUUID()
document.querySelector('#revision').textContent = descriptor.revision
document.querySelector('#state').textContent = descriptor.state
document.querySelector('#counter').textContent = String(descriptor.counter)
await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
const result = await fetch('/renderer', {
  method: 'POST',
  headers,
  signal: AbortSignal.timeout(10000),
  body: JSON.stringify({
    launch: descriptor.launch,
    revision: document.querySelector('#revision').textContent,
    document: documentId,
    state: document.querySelector('#state').textContent,
    counter: Number(document.querySelector('#counter').textContent),
    frameOpportunities: 2,
    nativeGlobalsAbsent:
      typeof globalThis.Bun === 'undefined' &&
      typeof globalThis.process === 'undefined' &&
      typeof globalThis.require === 'undefined',
  }),
})
if (!result.ok) throw new Error('Fixture renderer completion rejected')
