// Electron main process: owns the Library state, the GitHub client, the loopback
// servers for installed bundles, and the windows generators open in. The renderer
// only ever talks to it through the IPC surface in ipc.js.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, shell, session } from 'electron';
import { Library } from '../lib/library.js';
import { createServices } from './services.js';
import { registerIpc } from './ipc.js';
import { finishMove, resolveLocation } from './location.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(here, '..', 'renderer');

let mainWindow = null;
let services = null;

// Pick the data folder before Chromium starts, so its profile (what app windows
// save) lands there too. A move started in Settings finishes here.
const location = resolveLocation({ appData: app.getPath('userData') });
try {
  finishMove(location);
} catch (error) {
  console.error('Could not finish moving the library:', error);
}
app.setPath('userData', location.profileDir);

// Start again after the library has moved. A portable exe runs from a temporary
// copy that is deleted when it exits, so relaunch the real file.
function relaunch() {
  const execPath = process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE;
  app.relaunch(execPath ? { execPath } : undefined);
  app.exit(0);
}

async function chooseFolder({ title = 'Choose a folder', defaultPath } = {}) {
  const result = await dialog.showOpenDialog(mainWindow, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? '' : result.filePaths[0] ?? '';
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: 'Generator Library',
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1217',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      openExternal(url);
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(rendererDir, 'index.html'));
}

export function openExternal(url) {
  try {
    const target = new URL(url);
    if ((target.protocol === 'https:' || target.protocol === 'http:') && !target.username && !target.password) {
      shell.openExternal(target.href).catch(console.error);
    }
  } catch {
    /* ignore invalid urls */
  }
}

// Generators open in their own window with no preload and no Node access: a web
// generator is an ordinary web page as far as the library is concerned. Download
// links inside it get Electron's native save dialog.
export function openGeneratorWindow({ title, url, partition }) {
  const win = new BrowserWindow({
    title,
    width: 1440,
    height: 920,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#101820',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: partition || undefined,
    },
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternal(target);
    return { action: 'deny' };
  });
  win.loadURL(url);
  return win;
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });
  const library = new Library(location.libraryDir);
  await library.load();
  services = createServices({ library, app, openGeneratorWindow, openExternal, shell, location, relaunch, chooseFolder });
  registerIpc(services, () => mainWindow);
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', async () => {
  await services?.shutdown();
  if (process.platform !== 'darwin') app.quit();
});
