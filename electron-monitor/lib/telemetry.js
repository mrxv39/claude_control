/**
 * telemetry.js — Event batching, session lifecycle, heartbeat.
 *
 * Sends usage metrics to Supabase edge functions (cc-events, cc-heartbeat).
 * Only events in the whitelist are sent; the payload must be free of
 * project paths, file contents, prompts, or branch names.
 *
 * Offline: when a flush fails, events are appended to telemetry-queue.jsonl
 * (cap 1000 lines, FIFO rotation) and retried on the next successful flush.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./license');

const STATE_DIR = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'claudio-state');
const QUEUE_PATH = path.join(STATE_DIR, 'telemetry-queue.jsonl');

const FLUSH_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const FLUSH_BATCH_THRESHOLD = 20;
const FLUSH_BATCH_MAX = 100;
const QUEUE_FILE_CAP_LINES = 1000;
const FETCH_TIMEOUT_MS = 10_000;

/** Whitelist of allowed event types. Dropping unknowns prevents accidental leaks. */
const EVENT_WHITELIST = new Set([
  'app_start',
  'app_stop',
  'panel_toggle',
  'panel_tab_view',
  'skill_run',
  'skill_enqueue',
  'scheduler_pause',
  'scheduler_resume',
  'session_focus',
  'session_idle',
  'update_available',
  'update_applied',
  'error'
]);

/** @type {Array<{type:string,payload:object,timestamp:string}>} */
let queue = [];
let machineId = null;
let sessionId = null;
let appVersion = null;
let lastHeartbeatAt = 0;
let flushTimer = null;
let heartbeatTimer = null;
let enabled = false;

/**
 * Validate an event type against the whitelist.
 * @param {string} type
 * @returns {boolean}
 */
function isAllowedType(type) {
  return EVENT_WHITELIST.has(type);
}

/**
 * Scrub known sensitive fields from a payload. Conservative best-effort.
 * @param {object} payload
 * @returns {object}
 */
function scrubPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  const denied = new Set(['cwd', 'path', 'projectPath', 'branch', 'file', 'prompt', 'content', 'output', 'token', 'apiKey']);
  for (const [k, v] of Object.entries(payload)) {
    if (denied.has(k)) continue;
    if (k === 'stack' && typeof v === 'string') {
      out[k] = v.replace(/[A-Z]:\\[^\s)]+/g, '<path>').replace(/\/[^\s)]+/g, '<path>');
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * POST to a Supabase edge function. Returns parsed JSON or null on failure.
 * @param {string} fn
 * @param {object} body
 * @returns {Promise<object|null>}
 */
async function postFn(fn, body) {
  const url = `${SUPABASE_URL}/functions/v1/${fn}`;
  const fetchImpl = (() => {
    try { return require('electron').net.fetch; }
    catch { return (typeof fetch === 'function') ? fetch : null; }
  })();
  if (!fetchImpl) return null;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Append an event to the persistent queue file. Rotates if >cap lines.
 * @param {{type:string,payload:object,timestamp:string}} event
 */
function persistEvent(event) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(QUEUE_PATH, JSON.stringify(event) + '\n', 'utf-8');
    // Occasional rotation (every ~100 writes).
    if (Math.random() < 0.01) rotateQueueFile();
  } catch {}
}

/**
 * Trim queue file to QUEUE_FILE_CAP_LINES most recent entries.
 */
function rotateQueueFile() {
  try {
    if (!fs.existsSync(QUEUE_PATH)) return;
    const content = fs.readFileSync(QUEUE_PATH, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length <= QUEUE_FILE_CAP_LINES) return;
    const trimmed = lines.slice(-QUEUE_FILE_CAP_LINES);
    const tmp = QUEUE_PATH + '.tmp';
    fs.writeFileSync(tmp, trimmed.join('\n') + '\n', 'utf-8');
    fs.renameSync(tmp, QUEUE_PATH);
  } catch {}
}

/**
 * Read persisted events and clear the file (caller must handle re-persist on failure).
 * @returns {Array<{type:string,payload:object,timestamp:string}>}
 */
function drainPersistedEvents() {
  try {
    if (!fs.existsSync(QUEUE_PATH)) return [];
    const content = fs.readFileSync(QUEUE_PATH, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    fs.unlinkSync(QUEUE_PATH);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Record a telemetry event. Dropped if type is not whitelisted.
 * @param {string} type
 * @param {object} [payload]
 */
function trackEvent(type, payload = {}) {
  if (!enabled) return;
  if (!isAllowedType(type)) return;
  const event = {
    type,
    payload: scrubPayload(payload),
    timestamp: new Date().toISOString()
  };
  queue.push(event);
  if (queue.length >= FLUSH_BATCH_THRESHOLD) {
    flushEvents().catch(() => {});
  }
}

/**
 * Flush queued events to the backend. On failure, persist to JSONL.
 * @returns {Promise<void>}
 */
async function flushEvents() {
  if (!enabled || !machineId) return;
  const persisted = drainPersistedEvents();
  const batch = [...persisted, ...queue.splice(0, FLUSH_BATCH_MAX - persisted.length)];
  if (batch.length === 0) return;
  const res = await postFn('cc-events', {
    machineId,
    sessionId,
    events: batch
  });
  if (!res) {
    // Network failure — re-persist.
    for (const ev of batch) persistEvent(ev);
  }
}

/**
 * Send a heartbeat update to the backend.
 * @returns {Promise<void>}
 */
async function heartbeat() {
  if (!enabled || !machineId || !sessionId) return;
  const now = Date.now();
  const delta = lastHeartbeatAt ? Math.round((now - lastHeartbeatAt) / 1000) : 0;
  lastHeartbeatAt = now;
  if (delta <= 0) return;
  await postFn('cc-heartbeat', { machineId, sessionId, deltaSeconds: delta });
}

/**
 * Start a telemetry session. Generates sessionId, arms flush + heartbeat timers.
 * @param {string} mId
 * @param {string} version
 */
function startSession(mId, version) {
  machineId = mId;
  appVersion = version;
  sessionId = crypto.randomUUID();
  lastHeartbeatAt = Date.now();
  enabled = true;
  stopTimers();
  flushTimer = setInterval(() => { flushEvents().catch(() => {}); }, FLUSH_INTERVAL_MS);
  heartbeatTimer = setInterval(() => { heartbeat().catch(() => {}); }, HEARTBEAT_INTERVAL_MS);
}

function stopTimers() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

/**
 * End the current session: final flush + final heartbeat.
 * @returns {Promise<void>}
 */
async function endSession() {
  if (!enabled) return;
  stopTimers();
  await heartbeat();
  await flushEvents();
  enabled = false;
}

/**
 * For tests: reset internal state.
 */
function _resetForTests() {
  queue = [];
  machineId = null;
  sessionId = null;
  appVersion = null;
  lastHeartbeatAt = 0;
  stopTimers();
  enabled = false;
}

module.exports = {
  trackEvent,
  flushEvents,
  heartbeat,
  startSession,
  endSession,
  isAllowedType,
  scrubPayload,
  persistEvent,
  drainPersistedEvents,
  rotateQueueFile,
  EVENT_WHITELIST,
  QUEUE_PATH,
  FLUSH_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  FLUSH_BATCH_THRESHOLD,
  QUEUE_FILE_CAP_LINES,
  _resetForTests,
  _getQueue: () => queue.slice(),
  _getSessionId: () => sessionId
};
