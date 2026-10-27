// Identical renderer for every adapter. No host state is used to restore later documents.
async function runComparison() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token')
  if (!token || !/^[a-f0-9]{48}$/.test(token)) throw new Error('Missing fixture credential')
  history.replaceState(null, '', '/')
  const headers = { 'x-bunly-probe-token': token, 'content-type': 'application/json' }
  const documentId = crypto.randomUUID()
  const terminal = new globalThis.Terminal({ cols: 80, rows: 20, scrollback: 1000 })
  terminal.open(document.querySelector('#terminal'))
  const form = document.querySelector('#form')
  const write = (text) => new Promise((resolve) => terminal.write(text, resolve))
  const request = (path, options = {}) =>
    fetch(path, { headers, signal: AbortSignal.timeout(10000), ...options })
  let initialized = false
  let restored = false
  let revision = -1
  let transcript = ''
  let storageKey = ''
  let settledForm = ''
  for (;;) {
    const response = await request('/descriptor')
    if (response.status === 410) break
    if (response.status === 425) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      continue
    }
    if (!response.ok) throw new Error('Comparison descriptor failed')
    const descriptor = await response.json()
    if (!initialized) {
      storageKey = 'bunly-comparison-' + descriptor.storageKey
      const saved = localStorage.getItem(storageKey)
      if (descriptor.revision === 0) {
        if (saved !== null || typeof descriptor.initialForm !== 'string')
          throw new Error('Initial profile was not empty')
        // Simulate an unfinished edit once; later documents only read their own persisted form.
        form.value = descriptor.initialForm
        form.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        if (saved === null || descriptor.initialForm !== null)
          throw new Error('Browser form/transcript state was lost')
        const state = JSON.parse(saved)
        if (
          !Number.isSafeInteger(state.revision) ||
          state.revision !== descriptor.revision - 1 ||
          typeof state.form !== 'string' ||
          typeof state.transcript !== 'string' ||
          state.transcript.length > 128 * 1024
        )
          throw new Error('Invalid browser restoration')
        form.value = state.form
        transcript = state.transcript
        revision = state.revision
        restored = true
        await write(transcript)
      }
      settledForm = form.value
      initialized = true
    }
    if (descriptor.revision === revision) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      continue
    }
    if (descriptor.revision !== revision + 1 || form.value !== settledForm)
      throw new Error('Revision or form continuity failed')
    const bytes = await request('/bytes')
    if (!bytes.ok) throw new Error('Missing numbered output')
    const next = await bytes.text()
    transcript += next
    if (transcript.length > 128 * 1024) throw new Error('Transcript capacity exceeded')
    await write(next)
    revision = descriptor.revision
    document.querySelector('#revision').textContent = String(revision)
    const encoded = new TextEncoder().encode(transcript)
    let checksum = 2166136261
    for (const byte of encoded) checksum = Math.imul(checksum ^ byte, 16777619) >>> 0
    // Verify the actual xterm buffer ends at the expected numbered line, after its write callback.
    let last = ''
    for (let index = terminal.buffer.active.length - 1; index >= 0; index--) {
      const line = terminal.buffer.active.getLine(index)?.translateToString(true) ?? ''
      if (line) {
        last = line
        break
      }
    }
    const match = /^(\d{6}):x+$/.exec(last)
    if (!match) throw new Error('Rendered numbered terminal output is missing')
    localStorage.setItem(storageKey, JSON.stringify({ revision, form: form.value, transcript }))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const result = await request('/renderer', {
      method: 'POST',
      body: JSON.stringify({
        revision,
        document: documentId,
        form: form.value,
        restored,
        bytes: encoded.byteLength,
        checksum,
        lastSequence: Number(match[1]),
        frameOpportunities: 2,
        nativeGlobalsAbsent:
          typeof globalThis.Bun === 'undefined' &&
          typeof globalThis.process === 'undefined' &&
          typeof globalThis.require === 'undefined',
      }),
    })
    if (!result.ok) throw new Error('Comparison renderer completion rejected')
  }
}
// Complete module evaluation before native OnLoadEnd; the broker is granted asynchronously.
void runComparison()
