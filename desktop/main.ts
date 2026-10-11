import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, session, shell, Tray } from 'electron';
import { startServer } from '../server/src/app.ts';
import { configureDesktop } from '../server/src/desktop.ts';
import { enqueue, isBusy, stopDriver } from '../server/src/driver.ts';
import { state, subscribe, type Notice } from '../server/src/events.ts';
import { configurePaths } from '../server/src/paths.ts';

// This file is bundled to desktop/dist/main.mjs, so paths are relative to that folder.
const here = import.meta.dirname;
const repoRoot = join(here, '..', '..');
const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(repoRoot, 'build', 'icon.png');
/** Started by Windows at logon: stay in the tray. */
const startHidden = process.argv.includes('--hidden');

configurePaths({ clientDistDir: app.isPackaged ? join(process.resourcesPath, 'client') : join(repoRoot, 'client', 'dist') });

configureDesktop({
  autoStart: {
    get: () => app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
    set: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] }),
  },
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverPort = 0;
let quitting = false;

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 420,
    minHeight: 560,
    title: 'Gameout Driver',
    icon: iconPath,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  const origin = `http://127.0.0.1:${serverPort}`;
  mainWindow.loadURL(origin);
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // External links open in the real browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      if (url.startsWith('https://')) void shell.openExternal(url);
    }
  });

  // The driver keeps working in the tray: closing the window only hides it.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => (mainWindow = null));
}

/** Quits for real; a backup in progress would be lost, so ask first. */
async function quit() {
  if (isBusy()) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Continuar enviando', 'Sair mesmo assim'],
      defaultId: 0,
      cancelId: 0,
      title: 'Gameout Driver',
      message: `Há um backup em andamento${state.current ? ` (${state.current.name})` : ''}.`,
      detail: 'Saindo agora, ele é interrompido e precisa ser refeito.',
    });
    if (response === 0) return;
  }
  quitting = true;
  await stopDriver().catch(() => undefined);
  app.quit();
}

function trayMenu() {
  const autoStart = app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
  return Menu.buildFromTemplate([
    { label: 'Abrir', click: showWindow },
    {
      label: 'Sincronizar todas as pastas',
      enabled: state.backend.status === 'ok',
      click: () => state.folders.filter((folder) => folder.watching).forEach((folder) => enqueue(folder.id, folder.path, '')),
    },
    { type: 'separator' },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: autoStart,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { type: 'separator' },
    { label: 'Sair', click: () => void quit() },
  ]);
}

function trayTooltip() {
  if (!state.configured) return 'Gameout Driver: não configurado';
  if (state.current) return `Gameout Driver: enviando ${state.current.name}`;
  if (state.backend.status !== 'ok') return 'Gameout Driver: sem conexão com o servidor';
  return `Gameout Driver: ${state.folders.filter((folder) => folder.watching).length} pasta(s) observada(s)`;
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip(trayTooltip());
  tray.on('click', showWindow);
  // Rebuilt on open, so the checkbox and the enabled items match the current state.
  tray.on('right-click', () => tray?.popUpContextMenu(trayMenu()));

  subscribe((event, data) => {
    if (event === 'state') tray?.setToolTip(trayTooltip());
    // With the window hidden, failures still need to be seen.
    if (event === 'notice' && (data as Notice).kind === 'error' && !mainWindow?.isVisible() && Notification.isSupported()) {
      new Notification({ title: 'Gameout Driver', body: (data as Notice).message, icon: iconPath }).show();
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.victoralves.gameoutdriver');
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // Only our own server may be loaded by the window.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'"],
        },
      });
    });
    try {
      const server = await startServer(0);
      serverPort = server.port;
      app.on('will-quit', server.close);
      createTray();
      if (!startHidden) createWindow();
    } catch (error) {
      dialog.showErrorBox('Gameout Driver', `Não foi possível iniciar o serviço interno:\n${(error as Error).message}`);
      app.quit();
    }
  });

  // Lives in the tray: no window open is the normal state.
  app.on('window-all-closed', () => undefined);
}
