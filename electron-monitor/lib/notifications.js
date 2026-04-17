/**
 * notifications.js — Toast notifications and chime audio.
 *
 * Tracks BUSY→WAITING transitions with debounce (3 consecutive polls)
 * and shows a custom toast + plays a two-tone chime.
 */

/**
 * @typedef {Object} Session
 * @property {boolean} isClaude
 * @property {string} [cwd]
 * @property {string} [status] - 'BUSY' | 'WAITING' | 'IDLE'
 * @property {string} [project]
 * @property {number} [hwnd]
 * @property {number} [tabIndex]
 */

const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { escapeHtml } = require('./utils');

/** @type {Map<string, string>} cwd -> last known status */
const prevStatus = new Map();
/** @type {Map<string, string>} cwd -> status that started the WAITING streak */
const waitingSince = new Map();
/** @type {Map<string, number>} cwd -> consecutive WAITING polls (debounce) */
const waitingCount = new Map();

/**
 * Show a toast notification in the bottom-right corner.
 * @param {string} message - Text to display
 * @param {() => void} [onClick] - Callback when toast is clicked
 */
function showToast(message, onClick) {
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 320, H = 60;
  const toast = new BrowserWindow({
    width: W, height: H,
    x: wa.x + wa.width - W - 16,
    y: wa.y + wa.height - H - 16,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, resizable: false,
    hasShadow: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const safe = escapeHtml(message);
  const clickJs = onClick ? "onclick=\"document.title='clicked'\"" : '';
  const cursor = onClick ? 'cursor:pointer;' : '';
  toast.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
<!DOCTYPE html><html><body style="margin:0;font-family:'Segoe UI',sans-serif;${cursor}" ${clickJs}>
<div style="background:#1a1b26;border:1px solid #7aa2f7;border-radius:10px;padding:12px 18px;color:#c0caf5;font-size:13px;display:flex;align-items:center;gap:10px;height:100%;box-sizing:border-box;">
<span style="font-size:20px;">&#9989;</span>
<span>${safe}</span>
</div></body></html>`));
  toast.setAlwaysOnTop(true, 'screen-saver');
  toast.showInactive();
  if (onClick) {
    toast.webContents.on('page-title-updated', () => {
      onClick();
      try { toast.destroy(); } catch {}
    });
  }
  playChime();
  const autoClose = setTimeout(() => { try { toast.destroy(); } catch {} }, 5000);
  toast.on('closed', () => clearTimeout(autoClose));
}

/**
 * Track BUSY→WAITING transitions and notify with toast+chime after 3 consecutive polls.
 * @param {Session[]} sessions - Current session list
 * @param {(target: {hwnd: number, tabIndex: number}) => void} [onFocus] - Focus callback for toast click
 */
function checkStatusChanges(sessions, onFocus) {
  // Prune maps of dead sessions
  const liveCwds = new Set(sessions.filter(s => s.isClaude && s.cwd).map(s => s.cwd));
  for (const cwd of prevStatus.keys()) if (!liveCwds.has(cwd)) { prevStatus.delete(cwd); waitingSince.delete(cwd); waitingCount.delete(cwd); }

  for (const s of sessions) {
    if (!s.isClaude || !s.cwd) continue;
    const prev = prevStatus.get(s.cwd);
    prevStatus.set(s.cwd, s.status);
    if (s.status === 'WAITING') {
      const count = (waitingCount.get(s.cwd) || 0) + 1;
      waitingCount.set(s.cwd, count);
      if (count === 1) waitingSince.set(s.cwd, prev);
      if (waitingSince.get(s.cwd) === 'BUSY' && count === 3) {
        const hwnd = s.hwnd;
        const tabIndex = s.tabIndex;
        showToast(`${s.project} terminó — click para enfocar`, () => {
          if (onFocus) onFocus({ hwnd, tabIndex });
        });
      }
    } else {
      waitingCount.set(s.cwd, 0);
      waitingSince.delete(s.cwd);
    }
  }
}

/**
 * Generate a two-tone WAV chime (E6→B5) as a Buffer.
 * @returns {Buffer}
 */
function generateChimeWav() {
  const sampleRate = 22050;
  const tone1Freq = 1319; // E6
  const tone2Freq = 988;  // B5
  const tone1Dur = 0.35;
  const tone2Dur = 0.45;
  const pause = 0.08;
  const volume = 0.4;

  const totalSamples = Math.floor((tone1Dur + pause + tone2Dur) * sampleRate);
  const data = Buffer.alloc(totalSamples * 2); // 16-bit mono

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;
    if (t < tone1Dur) {
      const env = Math.min(1, t / 0.01) * Math.min(1, (tone1Dur - t) / 0.05);
      sample = Math.sin(2 * Math.PI * tone1Freq * t) * env * volume;
    } else if (t > tone1Dur + pause) {
      const t2 = t - tone1Dur - pause;
      const env = Math.min(1, t2 / 0.01) * Math.min(1, (tone2Dur - t2) / 0.08);
      sample = Math.sin(2 * Math.PI * tone2Freq * t2) * env * volume;
    }
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

/** @type {string|null} */
let chimePath = null;
let chimeInProgress = false;
/** Play the chime audio (generates WAV lazily). */
function playChime() {
  if (chimeInProgress) return;
  try {
    if (!chimePath) {
      const tmpDir = path.join(process.env.USERPROFILE, '.claude', 'claudio-state');
      chimePath = path.join(tmpDir, 'chime.wav');
      if (!fs.existsSync(chimePath)) {
        fs.writeFileSync(chimePath, generateChimeWav());
      }
    }
    chimeInProgress = true;
    require('child_process').execFile('powershell.exe',
      ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${chimePath.replace(/'/g, "''")}').PlaySync()`],
      { timeout: 5000 }, () => { chimeInProgress = false; });
  } catch { chimeInProgress = false; }
}

module.exports = { checkStatusChanges, showToast, playChime };
