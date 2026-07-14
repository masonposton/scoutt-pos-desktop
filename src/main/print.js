'use strict';
// print.js — receipt printing + cash drawer for the Star TSP100III / TSP143.
//
// That printer is host-based/GDI (a raster printer) with NO ESC/POS interpreter, so
// raw byte commands are silently dropped. The ONLY working path (verified by research
// against this exact model) is SILENT print through the installed Star Windows driver.
// The cash drawer kicks via the driver setting (Peripheral Unit Type = Cash Drawer,
// already live in prod) — so printing a receipt IS the drawer kick; there is no
// separate drawer command on this hardware. A "no-sale" drawer pop therefore prints a
// minimal job to trigger the driver.
//
// The web app sends its receipt HTML (payload.html). The shell force-blacks it (thermal
// heads print the app's warm-grey design tokens faint) and prints it in a hidden window.
// In smoke mode every "print" goes to printToPDF instead, so the whole render pipeline
// is provable headlessly on a Mac with no physical printer.

const { BrowserWindow } = require('electron');

const STAR_RE = /star|tsp100|tsp143|tsp650|futureprnt/i;
const RECEIPT_PX_WIDTH = 380; // ~80mm layout width; print size is set via @page/pageSize
const MICRONS_80MM = 80000;

// Force TRUE black + an 80mm no-margin page. Design-token greys print faint on thermal.
const PRINT_CSS = `
  @page { size: 80mm auto; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  * { color: #000 !important; border-color: #000 !important;
      -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
`;

function wrapReceipt(html) {
  const style = `<style>${PRINT_CSS}</style>`;
  if (/<html[\s>]/i.test(html)) {
    if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${style}`);
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${style}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${html}</body></html>`;
}

async function renderReceiptWindow(html) {
  const win = new BrowserWindow({
    show: false,
    width: RECEIPT_PX_WIDTH,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(wrapReceipt(html)));
  // Let the compositor paint before we print / printToPDF — calling immediately after
  // load resolves can fail ("Printing failed") on an offscreen window.
  await new Promise((r) => setTimeout(r, 200));
  return win;
}

function registerPrintHandlers(ipcMain, getMainWindow, config, log, opts = {}) {
  const smoke = !!opts.smoke;
  let appOrigin = null;
  try { appOrigin = new URL(config.appUrl).origin; } catch { appOrigin = null; }

  const fromTrusted = (event) => {
    if (smoke) return true;
    try { return !!appOrigin && new URL(event.senderFrame.url).origin === appOrigin; } catch { return false; }
  };

  let resolvedPrinter = config.printerName || null;

  async function listPrinters() {
    const wc = getMainWindow()?.webContents;
    if (!wc) return [];
    try {
      const printers = await wc.getPrintersAsync();
      return printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault, status: p.status }));
    } catch (e) { log.warn('getPrintersAsync failed', e); return []; }
  }

  async function resolveStarPrinter() {
    if (resolvedPrinter) return resolvedPrinter;
    const printers = await listPrinters();
    const star = printers.find((p) => STAR_RE.test(p.name || '') || STAR_RE.test(p.displayName || ''));
    const def = printers.find((p) => p.isDefault);
    resolvedPrinter = star?.name || def?.name || '';
    log.info('resolved printer', { resolvedPrinter, star: star?.name, default: def?.name, count: printers.length });
    return resolvedPrinter;
  }

  async function printHtml(html) {
    let win;
    try {
      win = await renderReceiptWindow(html);
      // Measure rendered height → explicit @page height in microns. 'auto' height is
      // unreliable on the Star/Windows pipeline (long blank tails); measuring avoids it.
      let heightMicrons = 0;
      try {
        const px = await win.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)');
        heightMicrons = Math.max(1000, Math.round(Number(px) * (MICRONS_80MM / RECEIPT_PX_WIDTH)));
      } catch { /* fall back to auto page height */ }

      if (smoke) {
        // Prove the render→print pipeline headlessly. Keep options minimal — the exact
        // 80mm sizing is a webContents.print concern (below) and needs the real printer.
        const data = await win.webContents.printToPDF({ printBackground: true });
        return { ok: true, mode: 'pdf', bytes: data.length, heightMicrons };
      }

      const deviceName = await resolveStarPrinter();
      const printOpts = { silent: true, printBackground: true, margins: { marginType: 'none' } };
      if (deviceName) printOpts.deviceName = deviceName;
      if (heightMicrons) printOpts.pageSize = { width: MICRONS_80MM, height: heightMicrons };

      return await new Promise((resolve) => {
        win.webContents.print(printOpts, (success, failureReason) => {
          if (!success) log.warn('print failed', { failureReason, deviceName });
          resolve(success
            ? { ok: true, mode: 'print', deviceName }
            : { ok: false, error: failureReason || 'print failed (check the Star is set as the Windows default)', deviceName });
        });
      });
    } catch (e) {
      log.error('printHtml error', e);
      return { ok: false, error: String(e?.message || e) };
    } finally {
      if (win && !win.isDestroyed()) setTimeout(() => { try { win.close(); } catch { /* ignore */ } }, 1500);
    }
  }

  ipcMain.handle('pos:get-status', async (event) => {
    if (!fromTrusted(event)) return { ok: false, error: 'untrusted' };
    return { ok: true, platform: process.platform, printerName: await resolveStarPrinter(), smoke };
  });
  ipcMain.handle('pos:list-printers', async (event) => {
    if (!fromTrusted(event)) return [];
    return listPrinters();
  });
  ipcMain.handle('pos:print-receipt', async (event, payload) => {
    if (!fromTrusted(event)) return { ok: false, error: 'untrusted' };
    const html = typeof payload === 'string' ? payload : payload?.html;
    if (!html || typeof html !== 'string') return { ok: false, error: 'no receipt html' };
    return printHtml(html);
  });
  ipcMain.handle('pos:open-drawer', async (event) => {
    if (!fromTrusted(event)) return { ok: false, error: 'untrusted' };
    return printHtml('<div style="height:1px"></div>'); // minimal job → driver kicks the drawer
  });

  // Warm the printer resolution so the first real receipt isn't slow/mis-routed.
  resolveStarPrinter().catch(() => {});
}

module.exports = { registerPrintHandlers };
