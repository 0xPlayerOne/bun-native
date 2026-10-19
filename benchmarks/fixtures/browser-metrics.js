/** Same-origin measurement instrumentation, loaded under the unchanged workbench CSP. */
;(() => {
  const metrics = { input: [], writes: [], trusted: 0 }
  const record = document.createElement('output')
  record.id = 'measurement-record'
  record.hidden = true
  document.body.appendChild(record)
  const flush = () => {
    record.textContent = JSON.stringify(metrics)
    record.dataset.inputCount = String(metrics.input.length)
  }
  flush()
  document.querySelector('#input').addEventListener('input', (event) => {
    if (!event.isTrusted) throw new Error('Untrusted input is not measured')
    if (metrics.input.length >= 1000) throw new Error('Input sample limit')
    metrics.trusted++
    const start = performance.now()
    const dispatch = event.timeStamp
    requestAnimationFrame(() => {
      metrics.input.push({
        handlerToFrame: performance.now() - start,
        eventToFrame: performance.now() - dispatch,
      })
      flush()
    })
  })
  const original = window.Terminal.prototype.write
  window.Terminal.prototype.write = function (data, callback) {
    const start = performance.now()
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength
    return original.call(this, data, () => {
      if (metrics.writes.length >= 8192) throw new Error('Terminal sample limit')
      metrics.writes.push({ bytes, callbackMs: performance.now() - start })
      flush()
      callback?.()
    })
  }
})()
