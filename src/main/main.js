'use strict';
// main.js — the Scoutt Pro POS shell (Electron main process).
//
// A kiosk window that loads the hosted Scoutt Pro web app (scouttpos.com) and adds
// what a browser can't give a retail counter: native silent receipt printing + cash
// drawer kick, kiosk lockdown, single-instance, crash/hang auto-recovery, an offline
// splash, and shell auto-update. The APP stays server-hosted (auto-updated on reload);
// this shell only adds the native + reliability layer.
//
// SECURITY (loading REMOTE content into a shell that exposes native power):
//   - contextIsolation + sandbox + nodeIntegration:false, set EXPLICITLY
//   - the preload exposes ONLY a tiny versioned bridge (never ipcRenderer/invoke)
//   - navigation FENCED to the app origin; the app's OWN about:blank print popups are
//     allowed (locked down); off-origin links only open externally when configured
//   - every native IPC handler re-verifies the sender frame's origin (print.js)

const { app, BrowserWindow, ipcMain, session, shell, globalShortcut, powerSaveBlocker, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');
const { loadConfig } = require('./config');
const { registerPrintHandlers } = require('./print');

log.transports.file.level = 'info';

const SMOKE = process.argv.includes('--smoke');

// Force IPv4-only DNS/connect. Root-caused 2026-07-15: a counter machine tethered to a
// phone hotspot had a dead/blackholed IPv6 default route (common on mobile hotspots — the
// interface advertises IPv6 but doesn't actually forward it). A full browser's network stack
// races IPv4/IPv6 (Happy Eyeballs) and silently falls back within ~250ms; this app's loadURL
// committed to the dead IPv6 attempt, timed out, and — because it's a kiosk window that never
// painted anything — left the counter staring at nothing with no error and no way to tell.
// This app never needs IPv6 (it only ever talks to scouttpos.com), so skip the class of
// failure entirely rather than depend on getting Happy-Eyeballs-equivalent timing right.
app.commandLine.appendSwitch('disable-ipv6');

let mainWindow = null;
let config = null;
let appOrigin = null;
let offlineFallbackActive = false;
let offlineRetryTimer = null;
let unresponsiveTimer = null;
let updateReady = false;
const crashTimes = []; // in-memory renderer-crash timestamps (fast reload-storm guard)

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
      additionalArguments: [`--scoutt-origin=${appOrigin}`, ...(SMOKE ? ['--scoutt-smoke'] : [])],
    },
  });
  mainWindow.removeMenu();

  const wc = mainWindow.webContents;

  // Navigation lock (both navigations and redirects). External http(s) links only leave
  // the kiosk when openExternalLinks is on (off by default on a locked counter).
  const guardNav = (e, url) => {
    if (isAppOrigin(url) || (SMOKE && /^(file|data):/i.test(url))) return;
    e.preventDefault();
    if (/^https?:/i.test(url) && config.openExternalLinks) shell.openExternal(url).catch(() => {});
  };
  wc.on('will-navigate', guardNav);
  wc.on('will-redirect', guardNav);
  wc.setWindowOpenHandler(({ url }) => {
    // The web app's print path opens a blank popup (window.open('','_blank')) for reports,
    // labels, close-out, and as the native-print fallback — allow it, locked down. Deny
    // everything else; off-origin links optionally open in the real browser.
    if (url === 'about:blank' || url === '') {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } };
    }
    if (/^https?:/i.test(url) && !isAppOrigin(url) && config.openExternalLinks) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // Crash recovery — never leave the counter on a dead screen. Fast in-memory guard (3
  // crashes/60s → relaunch) PLUS a persisted backoff so a deterministic crash can't spin
  // an infinite relaunch loop (state survives the relaunch).
  wc.on('render-process-gone', (_e, details) => {
    log.error('render-process-gone', details);
    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length && now - crashTimes[0] > 60000) crashTimes.shift();
    if (crashTimes.length >= 3) {
      if (recentRelaunches().length >= 2) { log.error('relaunch storm → fatal page'); showFatalPage(); return; }
      recordRelaunch();
      log.error('crash storm → clean relaunch');
      app.relaunch();
      app.exit(0);
      return;
    }
    loadApp(); // re-drive the correct URL (not reload of whatever happened to be showing)
  });
  // Hang recovery — a wedged renderer gets a grace period, then a forced crash that funnels
  // into the crash-recovery path above (README promises crash/HANG auto-recovery).
  wc.on('unresponsive', () => {
    log.warn('window unresponsive');
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      log.error('still unresponsive → forcing renderer crash for recovery');
      try { wc.forcefullyCrashRenderer(); } catch (e) { log.error(e); }
    }, 20000);
  });
  wc.on('responsive', () => {
    if (unresponsiveTimer) { clearTimeout(unresponsiveTimer); unresponsiveTimer = null; }
    log.info('window responsive again');
  });

  // Offline: swap to a bundled local splash; a self-healing poll (HEAD to the app URL, so
  // no false positives from a captive LAN) reloads the app the moment it's reachable.
  wc.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (errorCode === -3) return; // ERR_ABORTED (superseded navigation) — the poll owns retry
    if (isMainFrame && !SMOKE) { log.warn('did-fail-load', { errorCode, errorDesc, validatedURL }); showOfflineSplash(); }
  });
  wc.on('did-finish-load', () => {
    if (isAppOrigin(wc.getURL())) {
      offlineFallbackActive = false;
      if (offlineRetryTimer) { clearInterval(offlineRetryTimer); offlineRetryTimer = null; }
    }
  });

  // contentShown tracks whether REAL content has ever painted — set only inside
  // ready-to-show, Electron's own compositor-first-paint signal. Deliberately NOT
  // BrowserWindow.isVisible(): verified by direct test (2026-07-15) that on macOS,
  // kiosk+fullscreen windows fire the native OS 'show' event and report isVisible()===true
  // on their own, as part of entering the fullscreen Space, even with show:false and even
  // with NOTHING ever loaded — isVisible() cannot tell "an empty black rect is on screen"
  // from "the app actually painted." ready-to-show is unaffected by that OS-level quirk
  // (confirmed by the same test: it correctly never fires when nothing loads) — it's
  // Electron's own render-readiness signal, not the native window-manager visibility flag.
  let contentShown = false;
  mainWindow.once('ready-to-show', () => { contentShown = true; mainWindow.show(); });
  loadApp();

  // Visibility backstop: guarantee the window is never invisible-with-no-content forever,
  // regardless of WHY the initial load never resolves (the IPv6-blackhole case above is now
  // prevented at the source, but this is defense-in-depth against any other unforeseen hang —
  // a stalled DNS resolution, a captive portal, a proxy that neither succeeds nor errors). If
  // nothing has painted within 15s of starting the load, force the offline splash — which is
  // exactly the right state to land in: it explains what's wrong and self-heals the moment the
  // app becomes reachable (see did-fail-load's comment above). The contentShown flag makes
  // this idempotent: a normal fast load, or an earlier did-fail-load that already painted the
  // splash, both set it before 15s, so this simply no-ops.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !contentShown) {
      log.error('nothing painted 15s after load start — forcing offline splash');
      showOfflineSplash();
    }
  }, 15000);
}

function loadApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (SMOKE) { mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'smoke.html')).catch((e) => log.error('smoke load', e)); return; }
  mainWindow.loadURL(config.appUrl).catch((e) => log.warn('loadURL', e));
}

function showOfflineSplash() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  offlineFallbackActive = true;
  // Always (re)show the splash — covers a failed retry that would otherwise leave a raw
  // Chromium error page on screen.
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'offline.html')).catch(() => {});
  if (!offlineRetryTimer) offlineRetryTimer = setInterval(pollReconnect, 5000);
}

function pollReconnect() {
  if (!offlineFallbackActive || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const req = net.request({ method: 'HEAD', url: config.appUrl });
    req.on('response', () => { if (offlineFallbackActive) loadApp(); }); // reachable (any status) → load
    req.on('error', () => { /* still offline; try again next tick */ });
    req.end();
  } catch { /* net not ready — next tick */ }
}

function showFatalPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;background:#111214;color:#f4f2ee;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:2rem">
    <h1 style="font-size:1.4rem">Register needs attention</h1>
    <p style="color:#b9b4ac;max-width:34ch;line-height:1.5">The app kept restarting. Press <b>Ctrl+Shift+R</b> to try again, or <b>Ctrl+Shift+Q</b> to exit and relaunch it.</p></body>`;
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
}

// --- persisted relaunch backoff (survives app.relaunch) --------------------------
function relaunchLogPath() { return path.join(app.getPath('userData'), 'relaunch-log.json'); }
function recentRelaunches() {
  try {
    const arr = JSON.parse(fs.readFileSync(relaunchLogPath(), 'utf8'));
    const now = Date.now();
    return (Array.isArray(arr) ? arr : []).filter((t) => now - t < 5 * 60 * 1000);
  } catch { return []; }
}
function recordRelaunch() {
  try { const arr = recentRelaunches(); arr.push(Date.now()); fs.writeFileSync(relaunchLogPath(), JSON.stringify(arr)); } catch { /* ignore */ }
}

function registerKioskShortcuts() {
  if (!config.allowExit) return;
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    // If a shell update is staged, install it now (a controlled moment — not OS shutdown).
    if (updateReady) { log.info('staff exit → quitAndInstall'); try { autoUpdater.quitAndInstall(false, false); return; } catch (e) { log.error(e); } }
    log.info('staff kiosk exit');
    app.quit();
  });
  globalShortcut.register('CommandOrControl+Shift+R', () => loadApp());
}

function setupAutoUpdate() {
  if (!config.autoUpdate || !app.isPackaged) return; // off by default until signed + repo exists
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  // Do NOT auto-install on ambient quit: on a kiosk that means during Windows shutdown,
  // which can brick the app mid-write (electron-builder #7807/#3798). Install only at the
  // controlled staff-exit chord (above).
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('error', (e) => log.warn('autoUpdater error', e));
  autoUpdater.on('update-available', (i) => log.info('update available', i?.version));
  autoUpdater.on('update-downloaded', (i) => { updateReady = true; log.info('update downloaded, installs at next staff exit', i?.version); });
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
