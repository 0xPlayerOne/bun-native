/** Editable workload service. Its version changes are used by later reload adapters. */
export function service(name: string) {
  if (typeof name !== 'string' || name.length > 128) throw new Error('Invalid fixture name')
  return { version: 1, message: `Hello, ${name}` }
}
