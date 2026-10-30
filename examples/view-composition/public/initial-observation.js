// Deliberately a blocking, self-hosted classic script before the module client.
// Ordinary composition uses its original protocol and installs no extra observers.
;(() => {
  const url = new URL(location.href)
  const query = url.searchParams
  if (query.get('interaction') !== '2') return
  if (
    url.protocol !== 'app:' ||
    url.host !== 'ui' ||
    url.pathname !== '/index.html' ||
    url.hash ||
    query.getAll('pane').length !== 1 ||
    query.getAll('interaction').length !== 1 ||
    [...query.keys()].some((key) => key !== 'pane' && key !== 'interaction')
  )
    throw new Error('Invalid initial observation fixture mode')
  const pane = query.get('pane')
  if (!['left', 'right', 'overlay'].includes(pane)) throw new Error('Invalid observation pane')
  const instance = crypto.randomUUID()
  const events = []
  let overflow = false,
    stopped = false,
    phase = 'initial',
    initialRead = false
  const remove = () => {
    removeEventListener('focus', observe)
    removeEventListener('blur', observe)
    document.removeEventListener('visibilitychange', observe)
  }
  const sample = (event, trusted) => {
    if (stopped) throw new Error('Initial observation already stopped')
    // Sticky overflow fails qualification; never silently drop a transition.
    if (events.length === 32) {
      overflow = true
      remove()
      return
    }
    events.push(
      Object.freeze({
        event,
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        trusted,
      })
    )
  }
  const observe = (event) => sample(event.type, event.isTrusted)
  // Read before registering callbacks or running any application/client bootstrap.
  sample('initial', null)
  addEventListener('focus', observe)
  addEventListener('blur', observe)
  document.addEventListener('visibilitychange', observe)
  const stop = () => {
    remove()
    removeEventListener('pagehide', stop)
    stopped = true
  }
  addEventListener('pagehide', stop, { once: true })
  Object.defineProperty(globalThis, '__bunlyCompositionInitialObservation', {
    value: Object.freeze({
      instance,
      snapshot(next) {
        const expected = !initialRead
          ? 'initial'
          : phase === 'initial' && pane !== 'overlay'
            ? 'before-create'
            : phase === 'initial' || phase === 'before-create'
              ? 'after-create'
              : 'before-show'
        if (stopped || next !== expected) throw new Error('Invalid initial observation checkpoint')
        if (initialRead) sample(next, null)
        initialRead = true
        phase = next
        if (next === 'before-show') stop()
        return Object.freeze({
          pane,
          instance,
          phase,
          events: Object.freeze([...events]),
          overflow,
        })
      },
      stop,
    }),
  })
})()
