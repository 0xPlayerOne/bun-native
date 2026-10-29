import { treeObservationGate } from './fault-tree-notification.ts'
/** Fixed private descendant fixture, never an application process launcher. */
const nonce = process.env['BUNLY_CEF_FAULT_NONCE'] ?? ''
if (Bun.version !== '1.4.4' || !/^[a-f0-9]{48}$/.test(nonce))
  throw new Error('Explicit pinned native fault fixture required')
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  maxRequestBodySize: 1024,
  fetch: treeObservationGate(nonce, [process.ppid, process.pid]),
})
console.log(JSON.stringify({ pid: process.pid, parentPid: process.ppid, port: server.port, nonce }))
// Deliberately retain the listening server and inherited output after the backend
// exits. Native group/job cleanup, not parent-pipe EOF or a timed sleep, must stop us.
