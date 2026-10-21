import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '..')
const electron = process.argv.includes('--electron')
for (const directory of [
  'benchmarks/fixtures',
  ...(electron ? ['benchmarks/adapters/electron'] : []),
]) {
  const result = Bun.spawn([process.execPath, 'install', '--frozen-lockfile'], {
    cwd: resolve(root, directory),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await result.exited) !== 0)
    throw new Error(`Pinned dependency installation failed: ${directory}`)
}
if (electron) {
  const result = Bun.spawn(
    [
      process.execPath,
      resolve(root, 'benchmarks/adapters/electron/node_modules/electron/install.js'),
    ],
    { stdout: 'inherit', stderr: 'inherit' }
  )
  if ((await result.exited) !== 0) throw new Error('Pinned Electron binary installation failed')
}
console.log('Benchmark-only dependencies installed. These are not Bunly runtime payloads.')
