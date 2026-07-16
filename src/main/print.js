'use strict';
// print.js — receipt printing + cash drawer for the Star TSP100III / TSP143.
//
// That printer is host-based/GDI (a raster printer) with NO ESC/POS interpreter, so
// raw byte commands are silently dropped. The ONLY working path (verified by research
// against this exact model) is SILENT print through the installed Star Windows driver.
// The cash drawer kicks via the driver setting (Peripheral Unit Type = Cash Drawer,
// already live in prod) — so printing a receipt IS the drawer kick; there is no
// separate drawer command on this hardware. A "no-sale" drawer pop prints a minimal job.
//
// The web app sends its receipt HTML (payload.html). The shell force-blacks it (thermal
// heads print the app's warm-grey tokens faint) and prints it in a hidden window. In
// smoke mode every "print" goes to printToPDF instead, so the render pipeline is
// provable headlessly on a Mac with no physical printer.

const { BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');

const STAR_RE = /star|tsp100|tsp143|tsp650|futureprnt/i;
// Root-caused live 2026-07-15, confirmed directly against the driver: Windows' own print
// dialog for this Star shows its registered paper form as "72mm x Receipt", not 80mm — the
// roll stock is 80mm wide, but the print head's actual addressable/printable width (what the
// driver registers with Windows) is 72mm, same margin-vs-roll-width gap as most thermal
// receipt printers. Every silent-print attempt was building a DEVMODE at 80mm, a width this
// driver has no registered form for — which is exactly the "Invalid printer settings" failure
// (rejected before the job ever reaches the spooler) that every fallback-ladder variant hit,
// since only the WIDTH was ever wrong, not the margins or omitting a custom size entirely.
// Chromium's print pipeline lays out at 96 CSS px/inch. So a 72mm-wide receipt is
// 72/25.4*96 ≈ 272 CSS px wide, and 1 CSS px = 25400/96 ≈ 264.6 microns. Render width and the
// native pageSize width MUST match — printing a page rendered at one width onto a driver form
// of a different width means Chromium either clips or rescales the content, so this constant
// drives both (RECEIPT_PX_WIDTH and PRINT_CSS's @page below, plus MICRONS_RECEIPT_WIDTH used
// as the native pageSize.width in printHtml).
const RECEIPT_PX_WIDTH = Math.round((72 / 25.4) * 96); // ≈ 272
const MICRONS_PER_PX = 25400 / 96; // ≈ 264.58 µm/px
const MICRONS_RECEIPT_WIDTH = 72000;
const PRINT_TIMEOUT_MS = 10000; // per attempt; the fallback ladder below tries up to 3, so
// worst case (every attempt hangs rather than rejecting) is ~30s — matches the old single-
// attempt budget rather than multiplying it.

// Force TRUE black + a 72mm no-margin page (this driver's actual registered printable width —
// see RECEIPT_PX_WIDTH above). Design-token greys print faint on thermal.
const PRINT_CSS = `
  @page { size: 72mm auto; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  * { color: #000 !important; border-color: #000 !important;
      -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
`;

function wrapReceipt(html) {
  // A receipt never needs script; CSP blocks a compromised "receipt" from running JS in
  // this window. executeJavaScript (height measurement) bypasses page CSP, so it still works.
  const head = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'"><style>${PRINT_CSS}</style>`;
  if (/<html[\s>]/i.test(html)) {
    if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${head}`);
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`;
}

async function renderReceiptWindow(html) {
  const win = new BrowserWindow({
    show: false,
    width: RECEIPT_PX_WIDTH,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // This window renders remote-app-authored HTML — fence it like the main window so a
  // compromised "receipt" can't spawn a visible window over the kiosk or navigate away.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(wrapReceipt(html)));
  } catch (e) {
    if (!win.isDestroyed()) win.destroy(); // don't leak the window if the load rejects
    throw e;
  }
  // Let the compositor paint before printing — calling immediately can fail on an
  // offscreen window ("Printing failed").
  await new Promise((r) => setTimeout(r, 200));
  return win;
}

// PDF-based silent print: bypasses Chromium's Windows print backend entirely while keeping
// the Star Windows DRIVER in the path (mandatory on this hardware — see the header comment:
// raster-only, no ESC/POS interpreter, and the cash-drawer kick is a driver setting). The
// rendered receipt window is exported to a correctly-sized PDF (printToPDF's headless
// pipeline — which provably works on this codebase; it's exactly what smoke mode exercises),
// written to a temp file, and handed to the driver by SumatraPDF (bundled inside the
// pdf-to-printer package; asarUnpack'd in package.json so the .exe is spawnable from disk).
// 'noscale' keeps the 72mm-wide page 1:1 on the driver's 72mm form instead of letting
// anything rescale it. NOTE printToPDF's pageSize is in INCHES, unlike print()'s microns.
const PDF_PRINT_TIMEOUT_MS = 20000;
async function printViaPdf(win, deviceName, heightMicrons) {
  let tmpPath = null;
  try {
    const data = await win.webContents.printToPDF({
      printBackground: true,
      // Height floor of 1 inch: Chromium rejects sub-inch paper sizes, and the drawer-kick
      // job (a 1px div → ~1mm measured height) would otherwise hit exactly that.
      pageSize: { width: 72 / 25.4, height: Math.max(heightMicrons || 0, 25400) / 25400 },
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    tmpPath = path.join(app.getPath('temp'), `scoutt-receipt-${process.pid}-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, data);
    // Lazy require: Windows-only package (ships a bundled .exe) — never loaded on the
    // Mac dev/smoke path, which returns above before any native printing is attempted.
    const { print } = require('pdf-to-printer');
    await Promise.race([
      print(tmpPath, { printer: deviceName, scale: 'noscale', silent: true }),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('pdf print timeout')), PDF_PRINT_TIMEOUT_MS)),
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    if (tmpPath) fs.unlink(tmpPath, () => { /* best-effort temp cleanup */ });
  }
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
  let resolvedFromFallback = false; // true = we settled on the OS default, not a Star/config match

  async function listPrinters() {
    const wc = getMainWindow()?.webContents;
    if (!wc) return [];
    try {
      const printers = await wc.getPrintersAsync();
      return printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault, status: p.status }));
    } catch (e) { log.warn('getPrintersAsync failed', e); return []; }
  }

  // Re-resolve until we get a SOLID match (config or a Star). A default-printer fallback
  // (e.g. "Microsoft Print to PDF" when the Star hadn't enumerated yet at startup) is NOT
  // cached permanently — otherwise every receipt all day silently routes to the wrong device.
  async function resolveStarPrinter() {
    if (resolvedPrinter && !resolvedFromFallback) return resolvedPrinter;
    const printers = await listPrinters();
    const star = printers.find((p) => STAR_RE.test(p.name || '') || STAR_RE.test(p.displayName || ''));
    if (config.printerName) { resolvedPrinter = config.printerName; resolvedFromFallback = false; }
    else if (star) { resolvedPrinter = star.name; resolvedFromFallback = false; }
    else { resolvedPrinter = printers.find((p) => p.isDefault)?.name || ''; resolvedFromFallback = true; }
    log.info('resolved printer', { resolvedPrinter, resolvedFromFallback, count: printers.length });
    return resolvedPrinter;
  }

  async function printHtml(html) {
    let win;
    try {
      win = await renderReceiptWindow(html);
      // Measure the rendered height (at print width) → explicit @page height in microns.
      // 'auto' height is unreliable on the Star/Windows pipeline (long blank tails).
      let heightMicrons = 0;
      try {
        // Measure the CONTENT height, not documentElement.scrollHeight (which returns
        // max(content, viewport) → the 800px window height for a short receipt → a long
        // blank tail). body's bounding box is content-height since PRINT_CSS doesn't
        // stretch it, and it's laid out at RECEIPT_PX_WIDTH (the 72mm print width).
        const px = await win.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)');
        heightMicrons = Math.max(1000, Math.round(Number(px) * MICRONS_PER_PX));
      } catch { /* fall back to auto page height */ }

      if (smoke) {
        const data = await win.webContents.printToPDF({ printBackground: true });
        return { ok: true, mode: 'pdf', bytes: data.length, heightMicrons };
      }

      const deviceName = await resolveStarPrinter();
      const base = { silent: true, printBackground: true };
      if (deviceName) base.deviceName = deviceName;

      // Fallback ladder, most-customized first. "Invalid printer settings" is a settings-
      // negotiation failure from Chromium's Windows print backend — it happens before the job
      // ever reaches the spooler. Live v0.1.8 evidence: on the counter's Star TSP100 every one
      // of these variants fails identically (deviceName verified exact against Get-Printer, no
      // config override, correct 72mm width), so on THAT driver the whole webContents.print()
      // path is a dead end and rung 5 (printViaPdf) is what actually lands the job. The ladder
      // stays: on ordinary printers (HP/Epson at the office) silent print works fine and rung
      // 1-3 succeeds without ever touching SumatraPDF, and each attempt is logged for the next
      // time a driver misbehaves.
      const variants = [
        {
          label: 'full (custom page size, no margins)',
          opts: { ...base, margins: { marginType: 'none' }, ...(heightMicrons ? { pageSize: { width: MICRONS_RECEIPT_WIDTH, height: heightMicrons } } : {}) },
        },
        { label: 'driver default paper size (no margins)', opts: { ...base, margins: { marginType: 'none' } } },
        { label: 'driver defaults (no margin/page-size override)', opts: { ...base } },
      ];

      // Rung 4: no deviceName at all. Chromium resolves the DEFAULT printer through a
      // different backend path (default-settings lookup) than an explicitly named one
      // (per-printer settings negotiation) — there are real cases where the named path
      // fails and the default path works on the same driver. Only safe when the Star IS
      // the Windows default (it is on the counter machine — owner confirmed) — otherwise
      // this would silently print the receipt to some other device, so gate it hard.
      try {
        const printers = await listPrinters();
        const def = printers.find((p) => p.isDefault);
        if (def && def.name === deviceName) {
          variants.push({ label: 'default printer (no deviceName)', opts: { silent: true, printBackground: true } });
        }
      } catch { /* enumeration failed — skip this rung */ }

      let lastFailure = null;
      for (const { label, opts } of variants) {
        // Race the print callback against a timeout — some Windows driver failures never fire
        // the callback, which would otherwise hang the invoke promise and leak the window.
        const result = await new Promise((resolve) => {
          let settled = false;
          const done = (v) => { if (!settled) { settled = true; resolve(v); } };
          const timer = setTimeout(() => done({ success: false, failureReason: 'print timeout' }), PRINT_TIMEOUT_MS);
          win.webContents.print(opts, (success, failureReason) => {
            clearTimeout(timer);
            done({ success, failureReason });
          });
        });
        log.info('print attempt', { variant: label, opts, success: result.success, failureReason: result.failureReason });
        if (result.success) return { ok: true, mode: 'print', deviceName, viaDefault: resolvedFromFallback, variant: label };
        lastFailure = result.failureReason;
      }
      // Rung 5 — the real bypass. Root-caused 2026-07-15 from live v0.1.8 ladder output: EVERY
      // webContents.print() variant above fails with 'Invalid printer settings' before the job
      // ever reaches the spooler — including bare driver defaults with nothing but the printer
      // name — so the incompatibility is Chromium's print-settings negotiation with this Star
      // driver itself, not any specific option we pass. Skip that negotiation entirely:
      // render to PDF and print through the same driver via SumatraPDF (printViaPdf above).
      if (process.platform === 'win32' && deviceName) {
        const r = await printViaPdf(win, deviceName, heightMicrons);
        log.info('print attempt', { variant: 'pdf → SumatraPDF → driver', success: r.ok, failureReason: r.error });
        if (r.ok) return { ok: true, mode: 'pdf-native', deviceName, viaDefault: resolvedFromFallback, variant: 'pdf-native' };
        lastFailure = r.error || lastFailure;
      }

      log.warn('print failed on every variant', { deviceName, resolvedFromFallback, failureReason: lastFailure });
      return { ok: false, error: lastFailure || 'print failed (is the Star set as the Windows default?)', deviceName };
    } catch (e) {
      log.error('printHtml error', e);
      return { ok: false, error: String(e?.message || e) };
    } finally {
      if (win && !win.isDestroyed()) setTimeout(() => { try { win.close(); } catch { /* ignore */ } }, 1500);
    }
  }

  ipcMain.handle('pos:get-status', async (event) => {
    if (!fromTrusted(event)) return { ok: false, error: 'untrusted' };
    const printerName = await resolveStarPrinter();
    return { ok: true, platform: process.platform, printerName, printerIsDefaultFallback: resolvedFromFallback, smoke };
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

  resolveStarPrinter().catch(() => {}); // warm resolution so the first receipt isn't slow
}

module.exports = { registerPrintHandlers };
