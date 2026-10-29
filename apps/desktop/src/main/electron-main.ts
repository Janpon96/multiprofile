import { app, BrowserWindow, ipcMain, safeStorage, globalShortcut, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PersistentSecretStore } from '@multiprofile/storage';
import { AppController, IpcRequestEnvelope } from './controller.js';
import { ALLOWED_IPC_COMMANDS } from '../preload/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..', '..'); // apps/desktop
const REPO_ROOT = path.resolve(APP_DIR, '..', '..');
const EMERGENCY_HOTKEY = 'Control+Alt+Shift+S';
const RATE_LIMIT_PER_SEC = 200;

const dataRoot =
  process.env.MPS_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'MultiProfileStudio');
app.setPath('userData', path.join(dataRoot, 'electron'));

const indexHtmlPath = path.join(APP_DIR, 'public', 'index.html');
const indexHtmlUrl = pathToFileURL(indexHtmlPath).toString();

let controller: AppController | null = null;
let mainWindow: BrowserWindow | null = null;
let windowTimestamps: number[] = [];

function rateLimited(): boolean {
  const now = Date.now();
  windowTimestamps = windowTimestamps.filter((t) => now - t < 1000);
  if (windowTimestamps.length >= RATE_LIMIT_PER_SEC) return true;
  windowTimestamps.push(now);
  return false;
}

function createController(): AppController {
  const stateDir = path.join(dataRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const migrationsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'migrations')
    : path.join(REPO_ROOT, 'packages', 'storage', 'migrations');
  const secrets = new PersistentSecretStore(path.join(stateDir, 'secrets.json'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data)
  });
  return new AppController(path.join(stateDir, 'app.sqlite'), migrationsDir, secrets, {
    dataRoot,
    // MPS_HEADLESS=1 is for automated tests only; default is a visible browser window.
    headless: process.env.MPS_HEADLESS === '1'
  });
}

function senderIsTrusted(event: Electron.IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || !mainWindow || event.sender !== mainWindow.webContents) return false;
  return frame.url === indexHtmlUrl;
}

function registerIpc(): void {
  ipcMain.handle('mps:invoke', async (event, envelope: IpcRequestEnvelope) => {
    const requestId = envelope && typeof envelope.request_id === 'string' ? envelope.request_id : 'unknown';
    const fail = (code: string, message: string) => ({
      request_id: requestId,
      ok: false,
      error: { code, message, retryable: false }
    });
    if (!senderIsTrusted(event)) return fail('UNKNOWN', 'SECURITY_VIOLATION: untrusted sender');
    if (rateLimited()) return fail('UNKNOWN', 'RATE_LIMITED');
    if (!envelope || typeof envelope.command !== 'string' || !ALLOWED_IPC_COMMANDS.has(envelope.command)) {
      return fail('UNKNOWN', 'SECURITY_VIOLATION: command not in allowlist');
    }
    return controller!.handleIpc(envelope);
  });
}

function registerEmergencyHotkey(): boolean {
  const ok = globalShortcut.register(EMERGENCY_HOTKEY, async () => {
    if (!controller) return;
    const result = await controller.handleIpc({
      request_id: `hotkey_${Date.now()}`,
      command: 'sync.emergencyStop',
      payload: {}
    });
    mainWindow?.webContents.send('mps:emergency-stop', result);
  });
  if (!ok) console.error(`[MAIN] Could not register global hotkey ${EMERGENCY_HOTKEY} (already in use?)`);
  return ok;
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('file://') || details.url.startsWith('devtools://');
    callback({ cancel: !allowed });
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    title: 'MultiProfile Studio',
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload', 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== indexHtmlUrl) e.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(indexHtmlPath);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    hardenSession();
    controller = createController();
    try {
      controller.reconcileOrphans();
    } catch {
      // Orphan cleanup is best-effort; a failure must not block app startup.
    }
    registerIpc();
    registerEmergencyHotkey();
    createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  let shuttingDown = false;
  app.on('will-quit', (event) => {
    globalShortcut.unregisterAll();
    if (shuttingDown || !controller) return;
    // Stop all Chromium workers before the process exits.
    event.preventDefault();
    shuttingDown = true;
    const c = controller;
    controller = null;
    c.close()
      .catch(() => undefined)
      .finally(() => app.exit(0));
  });
}
