const parameters = new URLSearchParams(location.search)
const operation = parameters.get('operation')
const key = parameters.get('key')
const value = parameters.get('value')
if (!key || !['read', 'write'].includes(operation)) throw new Error('Invalid session fixture input')
if (operation === 'write') localStorage.setItem(key, value ?? '')
console.log(
  'BUNLY_SESSION_RESULT:' + JSON.stringify({ operation, key, value: localStorage.getItem(key) })
)
