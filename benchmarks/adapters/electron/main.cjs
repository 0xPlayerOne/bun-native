const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const started = performance.now();
const [originText, scenario, profile] = process.argv.slice(2);
const origin = new URL(originText);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !profile) throw new Error('Expected loopback fixture and isolated profile');
if (process.versions.electron !== '44.8.0') throw new Error('Unexpected Electron runtime');
app.setPath('userData', profile);
app.enableSandbox();
let mainWindow;
let browserWindow;
let done = false;
let navigationMs = null;
const watchdog = setTimeout(() => finish({ passed: false, error: 'Electron fixture deadline' }), 20000);
function finish(result) {
  if (done) return;
  done = true;
  clearTimeout(watchdog);
  console.log(JSON.stringify({ schema: 1, scenario, ...result, mainEntryToReportMs: performance.now() - started,
    runtime: 'Node', runtimeVersion: process.versions.node, engine: 'chromium', engineVersion: process.versions.chrome,
    frameworkVersion: process.versions.electron, navigationMs,
    securityProfile: result.sandboxed === true ? 'sandboxed-renderer+context-isolation+node-disabled' : 'unverified' }));
  setImmediate(() => result.passed ? app.quit() : app.exit(1));
}
process.once('uncaughtException', error => finish({ passed: false, error: String(error) }));
ipcMain.handle('workbench:finish', (event, result) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !event.senderFrame || event.senderFrame.parent ||
      new URL(event.senderFrame.url).origin !== origin.origin) throw new Error('Unauthorized fixture sender');
  if (!result || typeof result !== 'object' || typeof result.passed !== 'boolean' || JSON.stringify(result).length > 65536) throw new Error('Invalid result');
  if (result.passed && result.sandboxed !== true) { finish({ passed: false, error: 'Renderer sandbox was not active' }); return; }
  finish(result);
});
app.on('window-all-closed', () => { if (!done) finish({ passed: false, error: 'Window closed before result' }); });
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false };
  mainWindow = new BrowserWindow({ width: 1120, height: 760, show: true,
    webPreferences: { ...preferences, preload: path.join(__dirname, 'preload.cjs') } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin.origin) event.preventDefault(); });
  mainWindow.webContents.on('render-process-gone', (_event, details) => { if (!done) finish({ passed: false, error: 'Renderer failed: ' + details.reason }); });
  if (scenario === 'navigation' || scenario === 'lifecycle') {
    browserWindow = new BrowserWindow({ width: 480, height: 320, show: true, webPreferences: preferences });
    browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const navigationStarted = performance.now();
    await browserWindow.loadURL(origin.origin + '/page/form');
    if (scenario === 'navigation') {
      await browserWindow.loadURL(origin.origin + '/page/next');
      if (browserWindow.webContents.getURL() !== origin.origin + '/page/next') throw new Error('Navigation result mismatch');
    } else {
      await new Promise(resolve => { browserWindow.once('closed', resolve); browserWindow.close(); });
    }
    navigationMs = performance.now() - navigationStarted;
  }
  await mainWindow.loadURL(origin.origin + '/?scenario=' + encodeURIComponent(scenario));
}).catch(error => finish({ passed: false, error: String(error) }));
