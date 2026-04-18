// lib/startup-helpers.js — Helpers de arranque:
// - resolveScript: localiza scripts en dev (appRoot) o empaquetado (resourcesPath)
// - checkForUpdates: compara tag de GitHub release con package.json version
// - setupStatusLine: escribe config statusLine en ~/.claude/settings.json
// - checkHookSetup: avisa al renderer si falta el hook de Claude Code
// - ipcMain('run-setup-hook'): lanza setup-hook.ps1

const cp = require('child_process');
const { net } = require('electron');
const path = require('path');
const fs = require('fs');

function init({ appRoot, getMainWindow, telemetry, ipcMain, pkgVersion }) {
  const CLAUDE_SETTINGS_PATH = path.join(process.env.USERPROFILE, '.claude', 'settings.json');

  function resolveScript(name) {
    const dev = path.join(appRoot, name);
    if (fs.existsSync(dev)) return dev;
    return path.join(process.resourcesPath, name);
  }

  async function checkForUpdates() {
    try {
      const resp = await net.fetch('https://api.github.com/repos/mrxv39/claude_control/releases/latest');
      if (!resp.ok) return;
      const data = await resp.json();
      const latest = (data.tag_name || '').replace(/^v/, '');
      if (latest && latest !== pkgVersion) {
        const url = data.html_url || 'https://github.com/mrxv39/claude_control/releases/latest';
        const mw = getMainWindow();
        if (mw) mw.webContents.send('update-available', latest, url);
        telemetry.trackEvent('update_available', { from: pkgVersion, to: latest });
      }
    } catch {}
  }

  function setupStatusLine() {
    try {
      if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return;
      const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
      if (settings.statusLine && settings.statusLine.includes('statusline-writer') && !settings.statusLine.includes('\\\\\\\\')) return;
      const scriptPath = resolveScript('lib/statusline-writer.js');
      settings.statusLine = `node "${scriptPath}"`;
      const tmp = CLAUDE_SETTINGS_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8');
      fs.renameSync(tmp, CLAUDE_SETTINGS_PATH);
    } catch {}
  }

  function checkHookSetup() {
    const mw = getMainWindow();
    if (!mw) return;
    try {
      if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) { mw.webContents.send('hook-missing'); return; }
      const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
      if (!content.includes('claude-state-hook')) {
        mw.webContents.send('hook-missing');
      }
    } catch { mw.webContents.send('hook-missing'); }
  }

  ipcMain.handle('run-setup-hook', async () => {
    try {
      const script = resolveScript('setup-hook.ps1');
      // script path viene de resolveScript (controlado). No concatenamos input de usuario.
      cp.execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}"`,
        { encoding: 'utf-8', timeout: 30000 });
      return true;
    } catch { return false; }
  });

  return { resolveScript, checkForUpdates, setupStatusLine, checkHookSetup, CLAUDE_SETTINGS_PATH };
}

module.exports = { init };
