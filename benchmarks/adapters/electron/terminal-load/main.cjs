// Isolated benchmark addon: Electron Node main + one Bun controller + two Bun PTYs.
const { app, BrowserWindow, ipcMain, session } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const [origin, profile, bun, controller, mode, output, childEntry] = process.argv.slice(2)
if (process.versions.electron !== '44.9.3' || !['visible', 'hidden'].includes(mode))
  throw new Error('Unexpected pinned runtime or mode')
const url = new URL(origin)
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Loopback required')
app.setPath('userData', profile)
app.enableSandbox()
let window,
  child,
  completed = false,
  done = false,
  security = null,
  sequence = 0
const pending = new Map()
function send(value) {
  const line = JSON.stringify(value) + '\n'
  if (line.length > 128 * 1024 || child.stdin.writableLength > 2 * 1024 * 1024)
    throw new Error('Controller input bound')
  return new Promise((resolve, reject) =>
    child.stdin.write(line, (error) => (error ? reject(error) : resolve()))
  )
}
function authorized(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    !event.senderFrame ||
    event.senderFrame.parent ||
    event.senderFrame.url !== origin + '/'
  )
    throw new Error('Unauthorized load sender')
}
function finish(passed, error = null) {
  if (done) return
  done = true
  console.log(
    JSON.stringify({
      schema: 1,
      scenario: 'graphical-pty-load-v1',
      passed,
      error,
      frameworkVersion: process.versions.electron,
      node: process.versions.node,
      chromium: process.versions.chrome,
      platform: process.platform,
      arch: process.arch,
      security,
      backgroundThrottling:
        window?.webContents.getLastWebPreferences().backgroundThrottling !== false,
      topology: 'Electron-Node-main + Bun-controller + two-real-Bun-PTY-children',
      mode,
    })
  )
  // Normal exit only after the owned controller has exited; observer owns timeout cleanup.
  if (!child || child.exitCode !== null) {
    if (passed) app.quit()
    else app.exit(1)
  }
}
ipcMain.handle('load:call', async (event, method, value) => {
  authorized(event)
  if (JSON.stringify(value).length > 2048 || pending.size >= 64) throw new Error('RPC bound')
  const id = ++sequence
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Control RPC deadline'))
    }, 10000)
    pending.set(id, { resolve, reject, timer })
  })
  await send({ id, method, value })
  return result
})
ipcMain.handle('load:stream', async (event, packet) => {
  authorized(event)
  if (!(packet instanceof Uint8Array) || packet.length > 64 * 1024) throw new Error('Stream bound')
  await send({ stream: Buffer.from(packet).toString('base64') })
})
ipcMain.handle('load:security', (event, receipt) => {
  authorized(event)
  const preferences = window.webContents.getLastWebPreferences()
  if (
    !receipt.sandboxed ||
    !receipt.contextIsolated ||
    !receipt.nodeDisabled ||
    !preferences.sandbox ||
    !preferences.contextIsolation ||
    preferences.nodeIntegration
  )
    throw new Error('Security profile not established')
  security = {
    ...receipt,
    sandbox: preferences.sandbox,
    contextIsolation: preferences.contextIsolation,
    nodeIntegration: preferences.nodeIntegration,
  }
})
app.on('window-all-closed', () => {
  if (!done) finish(false, 'Window closed early')
})
app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false)
    )
    window = new BrowserWindow({
      width: 900,
      height: 640,
      show: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.cjs'),
      },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('render-process-gone', (_event, details) =>
      finish(false, 'Renderer gone: ' + details.reason)
    )
    child = spawn(bun, [controller], {
      env: {
        ...process.env,
        BUNLY_TERMINAL_LOAD_MODE: mode,
        BUNLY_TERMINAL_LOAD_OUTPUT: output,
        BUNLY_TERMINAL_LOAD_CHILD: childEntry,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stderr.pipe(process.stderr)
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      try {
        buffer += chunk.toString('utf8')
        if (buffer.length > 256 * 1024) throw new Error('Controller output bound')
        for (;;) {
          const end = buffer.indexOf('\n')
          if (end < 0) break
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          if (line.length > 128 * 1024) throw new Error('Controller frame bound')
          const item = JSON.parse(line)
          if (item.stream)
            window.webContents.send(
              'load:stream',
              new Uint8Array(Buffer.from(item.stream, 'base64'))
            )
          else if (item.id) {
            const request = pending.get(item.id)
            if (!request) continue
            pending.delete(item.id)
            clearTimeout(request.timer)
            if (item.error) request.reject(new Error(item.error))
            else request.resolve(item.value)
          } else if (item.show) {
            if (item.show === 'visible') window.show()
            else window.hide()
            void send({
              state: {
                visible: window.isVisible(),
                minimized: window.isMinimized(),
                focused: window.isFocused(),
              },
            }).catch((error) => finish(false, String(error)))
          } else if (item.complete) completed = true
          else if (item.failed) finish(false, item.failed)
        }
      } catch (error) {
        finish(false, String(error))
      }
    })
    child.once('error', (error) => finish(false, String(error)))
    child.once('exit', (code) => {
      if (!done)
        finish(
          code === 0 && completed && security !== null,
          code === 0 ? null : 'Controller exit ' + code
        )
      else app.exit(1)
    })
    await window.loadURL(origin + '/')
  })
  .catch((error) => finish(false, String(error)))
