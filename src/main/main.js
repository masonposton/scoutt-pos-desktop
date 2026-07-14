'use strict';
// main.js — the Scoutt Pro POS shell (Electron main process).
//
// A kiosk window that loads the hosted Scoutt Pro web app (scouttpos.com) and adds
// what a browser can't give a retail counter: native silent receipt printing + cash
// drawer kick, kiosk lockdown, single-instance, crash/hang auto-recovery, an offline
// splash, and shell auto-update. The APP stays server-hosted (auto-updated on reload);
// this shell only adds the native + reliability layer.
//
// SECURITY (loading REMOTE content into a shell that exposes native power) — per the
// Electron security docs:
//   - contextIsolation + sandbox + nodeIntegration:false, set EXPLICITLY
//   - the preload exposes ONLY a tiny versioned bridge (never ipcRenderer/invoke)
//   - navigation + new windows are FENCED to the app origin
//   - every native IPC handler re-verifies the sender frame's origin (print.js)

const { app, BrowserWindow, ipcMain, session, shell, globalShortcut, powerSaveBlocker, Menu } = require('electron');
const path = require('path');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');
const { loadConfig } = require('./config');
const { registerPrintHandlers } = require('./print');

log.transports.file.level = 'info';

const SMOKE = process.argv.includes('--smoke');

let mainWindow = null;
let config = null;
let appOrigin = null;
let offlineFallbackActive = false;
let offlineRetryTimer = null;
const crashTimes = []; // timestamps of recent renderer crashes (reload-storm guard)

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    config = loadConfig();
    if (SMOKE) { config.kiosk = false; config.autoUpdate = false; }
    try { appOrigin = new URL(config.appUrl).origin; } catch { appOrigin = 'https://scouttpos.com'; }
    log.info('Scoutt Pro POS starting', { version: app.getVersion(), appUrl: config.appUrl, kiosk: config.kiosk, smoke: SMOKE });

    Menu.setApplicationMenu(null);
    hardenSession();
    if (config.preventDisplaySleep) powerSaveBlocker.start('prevent-display-sleep');
    createWindow();
    registerPrintHandlers(ipcMain, () => mainWindow, config, log, { smoke: SMOKE });
    if (SMOKE) registerSmokeExit();
    registerKioskShortcuts();
    setupAutoUpdate();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}

function hardenSession() {
  const ses = session.defaultSession;
  // Deny every permission, both the async request and the sync check — a POS needs none.
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

function isAppOrigin(u) {
  try { return new URL(u).origin === appOrigin; } catch { return false; }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#111214',
    kiosk: config.kiosk,
    fullscreen: config.kiosk,
    frame: !config.kiosk,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // Pass the trusted origin (+ smoke flag) into the sandboxed preload's argv so it
      // only activates the native bridge for our own pages.
      additionalArguments: [`--scoutt-origin=${appOrigin}`, ...(SMOKE ? ['--scoutt-smoke'] : [])],
    },
  });
  mainWindow.removeMenu();

  const wc = mainWindow.webContents;

  // Keep the window pinned to the app origin — cover BOTH navigations and redirects.
  // External http(s) links (a vendor social link, an email) open in the real browser.
  const guardNav = (e, url) => {
    if (!isAppOrigin(url) && !(SMOKE && /^(file|data):/i.test(url))) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    }
  };
  wc.on('will-navigate', guardNav);
  wc.on('will-redirect', guardNav);
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isAppOrigin(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // Kiosk key lockdown: cashiers can't reload/close/devtools their way out. Staff use
  // the deliberate global chords below. Disabled in dev/smoke for debugging.
  if (config.kiosk && !SMOKE) {
    wc.on('before-input-event', (event, input) => {
      const k = (input.key || '').toLowerCase();
      const block =
        k === 'f12' ||
        (input.control && input.shift && (k === 'i' || k === 'c' || k === 'j')) || // devtools
        (input.control && k === 'r') || // reload
        (input.control && k === 'w') || // close tab
        (input.control && k === 'p');   // browser print dialog (we print natively)
      if (block) event.preventDefault();
    });
  }

  // Crash / hang recovery — never leave the counter on a dead screen. Guard against a
  // reload storm: after 3 crashes in 60s, do a clean full relaunch instead of spinning.
  wc.on('render-process-gone', (_e, details) => {
    log.error('render-process-gone', details);
    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length && now - crashTimes[0] > 60000) crashTimes.shift();
    if (crashTimes.length >= 3) { log.error('crash storm → relaunch'); app.relaunch(); app.exit(0); return; }
    safeReload();
  });
  wc.on('unresponsive', () => { log.warn('window unresponsive'); });
  wc.on('responsive', () => log.info('window responsive again'));

  // Offline: swap to a bundled local splash and keep retrying the real URL.
  wc.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (errorCode === -3) return; // ERR_ABORTED (superseded navigation)
    if (isMainFrame && !SMOKE) { log.warn('did-fail-load', { errorCode, errorDesc, validatedURL }); showOfflineSplash(); }
  });
  wc.on('did-finish-load', () => {
    if (isAppOrigin(wc.getURL())) {
      offlineFallbackActive = false;
      if (offlineRetryTimer) { clearTimeout(offlineRetryTimer); offlineRetryTimer = null; }
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  loadApp();
}

function loadApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (SMOKE) { mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'smoke.html')).catch((e) => log.error('smoke load', e)); return; }
  mainWindow.loadURL(config.appUrl).catch((e) => log.warn('loadURL', e));
}

function showOfflineSplash() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  offlineFallbackActive = true;
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'offline.html')).catch(() => {});
  if (offlineRetryTimer) clearTimeout(offlineRetryTimer);
  offlineRetryTimer = setTimeout(() => { if (offlineFallbackActive) loadApp(); }, 5000);
}

function safeReload() {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache(); }
  catch (e) { log.error('safeReload', e); }
}

function registerKioskShortcuts() {
  if (!config.allowExit) return;
  globalShortcut.register('CommandOrControl+Shift+Q', () => { log.info('staff kiosk exit'); app.quit(); });
  globalShortcut.register('CommandOrControl+Shift+R', () => safeReload());
}

function setupAutoUpdate() {
  if (!config.autoUpdate || !app.isPackaged) return; // updater no-ops in dev anyway
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  // Install on the next natural quit (end of day), never mid-transaction.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => log.warn('autoUpdater error', e));
  autoUpdater.on('update-available', (i) => log.info('update available', i?.version));
  autoUpdater.on('update-downloaded', (i) => log.info('update downloaded, installs on quit', i?.version));
  autoUpdater.checkForUpdatesAndNotify().catch((e) => log.warn('update check failed', e));
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
}

// --- smoke harness: run headless, report PASS/FAIL, exit with a code -------------
function registerSmokeExit() {
  ipcMain.handle('pos:smoke-done', (_e, results) => {
    const rows = Array.isArray(results) ? results : [];
    const pass = rows.length > 0 && rows.every((r) => r && r.ok);
    log.info('SMOKE_RESULT', rows);
    // eslint-disable-next-line no-console
    console.log('\n=== SCOUTT POS SHELL — SMOKE RESULT ===');
    for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
    console.log(`=== ${pass ? 'ALL PASS' : 'FAILURES'} (${rows.filter((r) => r.ok).length}/${rows.length}) ===\n`);
    setTimeout(() => app.exit(pass ? 0 : 1), 300);
    return { ok: true };
  });
  setTimeout(() => { log.error('smoke timeout'); console.log('SMOKE TIMEOUT'); app.exit(2); }, 30000);
}
