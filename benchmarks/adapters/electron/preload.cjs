const { contextBridge, ipcRenderer } = require('electron')
// This bridge exists only in the trusted local fixture window, never the browser view.
contextBridge.exposeInMainWorld('workbenchHost', {
  sandboxed: process.sandboxed === true,
  finish: (result) => ipcRenderer.invoke('workbench:finish', result),
})
