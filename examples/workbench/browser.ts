import { readDescriptor } from '../../packages/client/src/index.ts'
const descriptor = readDescriptor({
  name: 'mock',
  version: '0.1.0-dev.0',
  contractVersion: 1,
  capabilities: ['window.lifecycle', 'view.navigate', 'session.ephemeral'],
})
const output = document.querySelector('#output')
if (output) output.textContent = JSON.stringify(descriptor, null, 2)
