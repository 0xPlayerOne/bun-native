/** Real browser storage fixture; no native bridge or production account. */
const parameters = new URL(location.href).searchParams
const role = parameters.get('role')
const mode = parameters.get('mode')
if (!['A', 'B'].includes(role ?? '') || !['seed', 'present', 'empty'].includes(mode ?? ''))
  throw new Error('Invalid fixed storage fixture parameters')
const databaseName = 'bunly-offline-reset-fixture'
const cacheName = databaseName
const value = 'fixed-storage-value-' + role
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function database(write: boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('records')
    request.onerror = () => reject(new Error('IndexedDB open failed'))
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('records', write ? 'readwrite' : 'readonly')
      const operation = write
        ? transaction.objectStore('records').put(value, 'value')
        : transaction.objectStore('records').get('value')
      let result: unknown
      operation.onsuccess = () => {
        result = operation.result
      }
      transaction.oncomplete = () => {
        db.close()
        resolve(result)
      }
      transaction.onerror = transaction.onabort = () => {
        db.close()
        reject(new Error('IndexedDB transaction failed'))
      }
    }
  })
}
async function active(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.installing ?? registration.waiting ?? registration.active
  check(worker, 'Service worker has no state')
  if (worker.state === 'activated') return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Service worker activation timed out')), 5000)
    const listener = () => {
      if (worker.state === 'activated') finish()
      if (worker.state === 'redundant') finish(new Error('Service worker became redundant'))
    }
    function finish(error?: Error) {
      clearTimeout(timer)
      worker!.removeEventListener('statechange', listener)
      if (error) reject(error)
      else resolve()
    }
    worker.addEventListener('statechange', listener)
    listener()
  })
}
try {
  check(
    isSecureContext && navigator.serviceWorker && caches && indexedDB.databases,
    'Required actual browser storage APIs unavailable'
  )
  if (mode === 'seed') {
    localStorage.setItem(databaseName, value)
    await database(true)
    await (await caches.open(cacheName)).put('/stored-response', new Response(value))
    await active(await navigator.serviceWorker.register('/worker.js', { scope: '/' }))
  }
  const names = (await indexedDB.databases()).map((row) => row.name)
  const cacheNames = await caches.keys()
  const registrations = await navigator.serviceWorker.getRegistrations()
  if (mode === 'empty') {
    check(localStorage.getItem(databaseName) === null, 'localStorage survived full reset')
    check(!names.includes(databaseName), 'IndexedDB survived full reset')
    check(!cacheNames.includes(cacheName), 'CacheStorage survived full reset')
    check(registrations.length === 0, 'Service worker registration survived full reset')
  } else {
    check(localStorage.getItem(databaseName) === value, 'localStorage owner/persistence mismatch')
    check(
      names.includes(databaseName) && (await database(false)) === value,
      'IndexedDB owner/persistence mismatch'
    )
    check(cacheNames.includes(cacheName), 'CacheStorage missing')
    check(
      (await (await (await caches.open(cacheName)).match('/stored-response'))?.text()) === value,
      'CacheStorage owner mismatch'
    )
    check(
      registrations.length === 1 && registrations[0]?.active,
      'Persisted service worker registration missing'
    )
  }
  check(
    typeof (globalThis as { __bunlyRpc?: unknown }).__bunlyRpc === 'undefined',
    'Remote storage fixture gained RPC authority'
  )
  console.log('BUNLY_RESET_STORAGE_OK:' + role + ':' + mode)
} catch (error) {
  console.error('BUNLY_RESET_STORAGE_FAILED:' + String(error))
}
export {}
