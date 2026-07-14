# Scoutt Pro POS — desktop shell

An **Electron kiosk shell** that turns the hosted Scoutt Pro web app (`scouttpos.com`)
into a proper downloadable Windows register app — adding the things a browser can't:
**native silent receipt printing, a real cash-drawer kick, kiosk lockdown, crash
auto-recovery, an offline splash, and shell auto-update.**

> **Status (2026-07-14):** core shell built + proven on macOS via the headless smoke
> test (`npm run smoke` → all pass). The Windows installer + real Star hardware test
> still need a Windows machine — see **What still needs a human** below.

## Why a shell (not a rewrite)

The app is a server app (Next.js App Router + Neon + RLS) — it can't be static-bundled,
and it already updates itself on every reload. So this shell **loads the live URL** and
only adds the native + reliability layer around it. Benefits:

- **Native printing** replaces the browser popup-print workaround. The Star's cash
  drawer kicks on every receipt (via the printer driver), no WebUSB.
- **Kiosk lockdown** — fullscreen, no browser chrome, cashiers can't reload/close/
  devtools out; staff exit with a deliberate chord.
- **Reliability** — single-instance, crash/hang auto-recovery, "reconnecting" splash
  instead of a raw Chromium error page when the network drops.
- **Auto-update** the shell binary; the app updates server-side.

## Architecture

```
 ┌─────────────────────────────── Electron main process ───────────────────────────────┐
 │  main.js      kiosk BrowserWindow → loads https://scouttpos.com                       │
 │               single-instance · nav locked to origin · crash/offline recovery         │
 │  print.js     native receipt print (silent, via the Star Windows driver) + drawer     │
 │  config.js    per-counter config (<userData>/config.json)                             │
 └───────────────────────────────────────┬───────────────────────────────────────────────┘
                                          │ contextBridge (sandboxed preload)
                                          ▼
   window.scouttPOSNative  ── the ONLY native surface the web app can reach ──
     .printReceipt({ html })   .openCashDrawer()   .listPrinters()   .getStatus()
```

**Security:** loads REMOTE content, so it's locked down hard — `contextIsolation` +
`sandbox` + `nodeIntegration:false`, a narrow versioned bridge (never `ipcRenderer`),
navigation + new-windows fenced to `scouttpos.com`, all permissions denied, and every
native IPC handler re-verifies the sender frame's origin.

## The native bridge (what the web app calls)

The web app **feature-detects** the bridge and uses it when present, else falls back to
the current browser popup-print:

```js
const native = window.scouttPOSNative;
if (native?.version >= 1) {
  await native.printReceipt({ html: receiptHtml }); // silent print + drawer kick
} else {
  openPopupPrintWindow(receiptHtml);                // unchanged browser behavior
}
```

`printReceipt({ html })` — the app sends its existing receipt HTML; the shell
force-blacks it (thermal heads print the app's warm-grey tokens faint) and prints it
silently to the Star. `openCashDrawer()` prints a minimal job so the driver pops the
drawer (no-sale / paid-out). `listPrinters()` / `getStatus()` are for a Settings/diag
screen.

## Printing model (Star TSP100III / TSP143)

That printer is **host-based / GDI** — it has no ESC/POS interpreter, so raw byte
commands are silently dropped. The only working path is **silent print through the
installed Star Windows driver**, and the **cash drawer kicks via the driver setting**,
not a command:

- Printer properties → Device Settings → Installable Options →
  **Peripheral Unit Type = Cash Drawer**, **Peripheral Unit 1 = Document Top**
  (already configured + working in prod). Printing a receipt IS the drawer kick.
- Set the **Star as the Windows default printer** (belt-and-suspenders for `silent`).
- Do **not** use serialport / node-thermal-printer / ESC/POS here — wrong hardware class.

## Config (`<userData>/config.json`)

Per-counter, editable without a rebuild. On Windows userData is
`%APPDATA%\Scoutt Pro POS`. All keys optional; defaults in `src/main/config.js`:

```jsonc
{
  "appUrl": "https://scouttpos.com", // the register URL to load
  "kiosk": true,                     // fullscreen kiosk lockdown
  "autoUpdate": true,                // check GitHub Releases for shell updates
  "printerName": "",                 // "" = auto-detect Star / OS default; or the exact name
  "kickDrawerOnPrint": true,
  "allowExit": true,                 // enable the staff exit chord (Ctrl+Shift+Q)
  "preventDisplaySleep": true
}
```

Dev overrides: `--url=<url>`, `SCOUTT_POS_URL=<url>`, `--dev` (disables kiosk + updater).

## Develop / test (macOS or Windows)

```bash
npm install
npm run smoke   # headless: exercises the bridge + render→print pipeline (→PDF), prints PASS/FAIL, exits
npm run dev     # windowed (kiosk off), loads scouttpos.com — for eyeballing
npm start       # kiosk mode
```

Staff chords: **Ctrl+Shift+Q** exit kiosk · **Ctrl+Shift+R** reload.

## Build the Windows installer

**Do this on Windows (or CI), not macOS** — NSIS cross-build needs wine and can't
code-sign.

- **CI (recommended):** push a tag → `.github/workflows/release.yml` builds on
  `windows-latest` and publishes the installer + `latest.yml` to GitHub Releases:
  ```bash
  git tag v0.1.0 && git push origin v0.1.0
  ```
- **Locally on a Windows box:** `npm run build:win` → `dist/Scoutt Pro POS-Setup-0.1.0.exe`.

Auto-update: the installed app polls this repo's Releases; ship a new version by
bumping `version` and pushing a new `v*` tag.

## Deploy to a counter PC

1. Install the Star driver; set the Star as the **Windows default printer**; confirm the
   **Cash Drawer** driver setting.
2. Run the installer (one-time SmartScreen "More info → Run anyway" until code signing
   is set up — fine for internal machines).
3. (Optional) drop a `config.json` in `%APPDATA%\Scoutt Pro POS` to pin the printer name
   or app URL.
4. Launch; sign into Scoutt Pro; ring a test sale → receipt prints + drawer kicks.

## What still needs a human

- **Build + run the `.exe` on Windows** and test against the **real Star printer +
  drawer** (silent print, receipt darkness, drawer kick, @page height / no blank tail).
- **Code signing** — Azure Trusted Signing (~$10/mo) is the cheapest 2025 path; unsigned
  is usable for internal counters (one-time "Run anyway"). Verify LLC age ≥ 3 yrs for
  eligibility.
- **Create the public GitHub repo** `masonposton/scoutt-pos-desktop` (or change the
  `build.publish` owner/repo) so auto-update + CI releases work.
- **App icon** — add `build/icon.ico`; electron-builder uses a default otherwise.
- **The web-app half** — a branch in `mallpos` makes the register's receipt-print path
  prefer `window.scouttPOSNative` when present (see that branch; not yet deployed).
- **Windows OS-level kiosk** (Assigned Access) if you want to block Alt+Tab / Ctrl+Alt+Del
  — Electron kiosk hides chrome but isn't OS lockdown.
