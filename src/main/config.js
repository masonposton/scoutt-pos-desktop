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
  kiosk: true, // fullscreen kiosk (no chrome, no menu). --dev disables for local testing.
  autoUpdate: true, // check GitHub Releases (or configured feed) for shell updates
  printerName: '', // '' = OS default printer; set to the Star's exact name to force it
  kickDrawerOnPrint: true, // pulse the cash drawer when a sale receipt prints
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
  }
  return cfg;
}

module.exports = { loadConfig, DEFAULTS };
