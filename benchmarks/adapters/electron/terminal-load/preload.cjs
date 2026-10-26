const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('terminalLoadHost', {
  security: (nodeDisabled) =>
    ipcRenderer.invoke('load:security', {
      sandboxed: process.sandboxed === true,
      contextIsolated: process.contextIsolated === true,
      nodeDisabled: nodeDisabled === true,
    }),
  call: (method, value) => ipcRenderer.invoke('load:call', method, value),
  send: (packet) => ipcRenderer.invoke('load:stream', packet),
  subscribe: (receive) => {
    const listener = (_event, packet) => receive(packet)
    ipcRenderer.on('load:stream', listener)
    return () => ipcRenderer.removeListener('load:stream', listener)
  },
})
