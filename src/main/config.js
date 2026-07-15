'use strict';
// config.js — per-install configuration for the Scoutt Pro POS shell.
//
// Precedence (low → high):
//   1. built-in DEFAULTS below
//   2. <userData>/config.json    (per-counter overrides, editable without a rebuild —
//                                 e.g. which Star printer, kiosk on/off; NOT committed)
//   3. env / CLI overrides       (dev convenience: --url=, SCOUTT_POS_URL, --dev)
//
// The web app is loaded from `appUrl`; navigation is fenced to that origin (main.js),
// so this is also the ONLY origin the native hardware bridge will act for.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULTS = {
  appUrl: 'https://scouttpos.com',
  // Maximize on launch so the register fills the screen. Owner feedback 2026-07-15: this used
  // to ALSO strip the window's title bar (Electron's kiosk:true), leaving no way to minimize
  // or close without a hidden shortcut — main.js's frame is now unconditionally true, so this
  // field only controls the maximize. --dev disables (small window for local testing).
  kiosk: true,
  // Auto-update is a code-execution channel, so it was gated OFF until two conditions were
  // met: (a) the release repo (masonposton/scoutt-pos-desktop) actually existed under the
  // owner's account — an unsigned feed pointed at a not-yet-existing/squattable repo name is
  // an RCE risk — and (b) explicit owner approval. Both are now true: the repo is real, and as
  // of 2026-07-15 it has four legitimate signed-checksum releases (v0.1.1–v0.1.4) published via
  // the hardened CI pipeline (.github/workflows/release.yml). Owner approved flipping this on.
  // Known remaining gap: the shell itself is still NOT Authenticode-code-signed. That mainly
  // affects first-install Windows SmartScreen UX (an "unknown publisher" warning on the very
  // first install), not update safety — electron-updater still verifies each downloaded update
  // against a checksum over HTTPS, fetched from a repo only the owner can publish to. So this
  // default being `true` is a deliberate call, not an oversight; get a cert before relying on
  // silent SmartScreen-free installs.
  autoUpdate: true,
  printerName: '', // '' = OS default printer; set to the Star's exact name to force it
  // Off-origin http(s) links: on a locked counter, popping the OS browser over the kiosk is
  // a lockdown escape. Off by default in kiosk; dev keeps external links clickable.
  openExternalLinks: false,
  allowExit: true, // enable the staff kiosk-exit shortcut (Ctrl+Shift+Q)
  preventDisplaySleep: true, // keep the counter screen awake
};

function loadConfig() {
  let cfg = { ...DEFAULTS };
  try {
    const userCfgPath = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(userCfgPath)) {
      cfg = { ...cfg, ...JSON.parse(fs.readFileSync(userCfgPath, 'utf8')) };
    }
  } catch {
    // malformed config.json → fall back to defaults rather than crash the counter
  }
  const urlArg = process.argv.find((a) => a.startsWith('--url='));
  if (urlArg) cfg.appUrl = urlArg.slice('--url='.length);
  if (process.env.SCOUTT_POS_URL) cfg.appUrl = process.env.SCOUTT_POS_URL;
  if (process.argv.includes('--dev')) {
    cfg.kiosk = false;
    cfg.autoUpdate = false;
    cfg.openExternalLinks = true; // dev: keep external links clickable
  }
  return cfg;
}

module.exports = { loadConfig, DEFAULTS };
