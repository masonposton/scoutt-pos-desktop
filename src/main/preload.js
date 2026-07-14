'use strict';
// preload.js — the ONLY bridge between the remote web app and native power.
//
// Runs sandboxed (no Node modules here — just ipcRenderer + contextBridge, which
// are sandbox-safe). It exposes a NARROW, versioned `window.scouttPOSNative` with
// one function per capability; it never exposes ipcRenderer or a generic invoke,
// which would let the remote page reach any IPC channel (the Electron-security
// footgun). All real hardware work happens in the main process behind ipcMain.handle.
//
// The bridge activates ONLY for the trusted app origin (passed in from main via
// webPreferences.additionalArguments, which land in this preload's process.argv),
// or the local smoke harness — defence-in-depth on top of main's navigation lock.

const { contextBridge, ipcRenderer } = require('electron');

function argValue(prefix) {
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : null;
}
const trustedOrigin = argValue('--scoutt-origin=');
const smoke = process.argv.includes('--scoutt-smoke');

function isTrusted() {
  if (smoke) return true;
  try { return !!trustedOrigin && window.location.origin === trustedOrigin; } catch { return false; }
}

if (isTrusted()) {
  const api = {
    version: 1,
    platform: process.platform, // 'win32' on the counter, 'darwin' in dev
    // Print a receipt. payload = { html } (the web app's existing receipt HTML) —
    // the shell force-blacks it (thermal heads print warm greys faint) and prints
    // silently to the Star; the cash drawer kicks via the printer driver.
    printReceipt: (payload) => ipcRenderer.invoke('pos:print-receipt', payload),
    // No-sale / paid-out drawer pop (prints a minimal job; on this GDI Star the
    // drawer only fires as part of a print job).
    openCashDrawer: () => ipcRenderer.invoke('pos:open-drawer'),
    // Installed printers, so a Settings screen can confirm/choose the Star.
    listPrinters: () => ipcRenderer.invoke('pos:list-printers'),
    // Shell + printer diagnostics.
    getStatus: () => ipcRenderer.invoke('pos:get-status'),
  };
  if (smoke) api.__smokeReport = (results) => ipcRenderer.invoke('pos:smoke-done', results);
  contextBridge.exposeInMainWorld('scouttPOSNative', api);
}
