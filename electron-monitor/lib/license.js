/**
 * license.js — First-run activation gate and periodic license validation.
 *
 * Reads Windows MachineGuid, persists a local license.json cache, talks to
 * Supabase edge functions (cc-register / cc-validate). Grace period of 7
 * days allows offline use after a successful validation.
 *
 * v1: backend auto-grants on registration. Revocation is done by toggling
 * `status` in the `cc_installations` table from Supabase Studio.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const SUPABASE_URL = 'https://hyydkyhvgcekvtkrnspf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_cih6ONljXU1ddhHNChZvkA_7AYhW7W3';

const STATE_DIR = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'claudio-state');
const LICENSE_PATH = path.join(STATE_DIR, 'license.json');

const REVAL_MS = 6 * 60 * 60 * 1000;          // re-validate online every 6h
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;     // 7 days offline allowed
const FETCH_TIMEOUT_MS = 10000;

/** @typedef {{machineId:string,email:string,name?:string,status:string,plan?:string,registeredAt:string,lastValidatedAt:string}} LicenseData */

/**
 * Read Windows MachineGuid from registry. Falls back to a deterministic hash
 * of hostname+username if the registry is unreachable.
 * @returns {Promise<string>}
 */
function getMachineId() {
  return new Promise(resolve => {
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (!err && stdout) {
          const match = stdout.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
          if (match && match[1]) return resolve(match[1].trim().toLowerCase());
        }
        // Fallback: deterministic hash (still unique per machine+user)
        const fallback = crypto.createHash('sha256')
          .update(`${os.hostname()}|${os.userInfo().username}`)
          .digest('hex')
          .slice(0, 36);
        resolve(fallback);
      });
  });
}

/**
 * Load license from disk. Returns null if not found or unparseable.
 * @returns {LicenseData|null}
 */
function getLocalLicense() {
  try {
    if (!fs.existsSync(LICENSE_PATH)) return null;
    const content = fs.readFileSync(LICENSE_PATH, 'utf-8');
    const data = JSON.parse(content);
    if (!data.machineId || !data.email) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Write license to disk atomically (tmp + rename).
 * @param {LicenseData} data
 */
function saveLocalLicense(data) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  const tmp = LICENSE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, LICENSE_PATH);
}

/**
 * POST helper using electron.net.fetch (keeps the same module used by auto-update).
 * Falls back to node's global fetch if electron isn't loaded (tests).
 * @param {string} fn - Edge function name
 * @param {object} body
 * @returns {Promise<object|null>} parsed JSON or null on network error
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
 * Register a new installation. Auto-grants active in v1.
 * @param {{machineId:string,email:string,name?:string,hostname:string,username:string,appVersion:string}} info
 * @returns {Promise<{status:string,plan?:string,message?:string}|null>}
 */
async function register(info) {
  return postFn('cc-register', info);
}

/**
 * Validate a license against the backend.
 * @param {string} machineId
 * @param {string} appVersion
 * @returns {Promise<{status:string,revokedReason?:string,plan?:string}|null>}
 */
async function validate(machineId, appVersion) {
  return postFn('cc-validate', { machineId, appVersion });
}

/**
 * Decide whether the cached license is fresh enough to skip online revalidation.
 * Pure function — easy to unit-test.
 * @param {LicenseData} license
 * @param {number} now - epoch ms
 * @returns {boolean}
 */
function isCacheFresh(license, now) {
  if (!license || !license.lastValidatedAt) return false;
  const t = new Date(license.lastValidatedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return (now - t) < REVAL_MS;
}

/**
 * Whether a stale cache is still inside the offline grace window.
 * @param {LicenseData} license
 * @param {number} now
 * @returns {boolean}
 */
function isWithinGrace(license, now) {
  if (!license || !license.lastValidatedAt) return false;
  const t = new Date(license.lastValidatedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return (now - t) < GRACE_MS;
}

/**
 * Main startup gate. Orchestrates activation / validation / grace logic.
 * @returns {Promise<{ok?:true,revoked?:true,needsActivation?:true,needsReconnect?:true,offline?:boolean,machineId?:string,reason?:string,license?:LicenseData}>}
 */
async function checkLicenseGate() {
  const machineId = await getMachineId();
  const license = getLocalLicense();
  const now = Date.now();

  // First run, or someone copied the license.json across machines.
  if (!license || license.machineId !== machineId) {
    return { needsActivation: true, machineId };
  }

  // Revoked in cache — app was already quit after last revalidation.
  if (license.status === 'revoked') {
    return { revoked: true, reason: license.revokedReason || 'Acceso revocado.', machineId, license };
  }

  // Cache still fresh — skip network call.
  if (license.status === 'active' && isCacheFresh(license, now)) {
    return { ok: true, machineId, license };
  }

  // Need to revalidate online.
  const res = await validate(machineId, license.appVersion || '');
  if (res && res.status) {
    if (res.status === 'revoked') {
      const reason = res.revokedReason || 'Acceso revocado.';
      saveLocalLicense({ ...license, status: 'revoked', revokedReason: reason, lastValidatedAt: new Date().toISOString() });
      return { revoked: true, reason, machineId, license };
    }
    if (res.status === 'unknown') {
      // Backend doesn't know about us — need to re-register.
      return { needsActivation: true, machineId, license };
    }
    saveLocalLicense({ ...license, status: res.status, plan: res.plan || license.plan, lastValidatedAt: new Date().toISOString() });
    return { ok: true, machineId, license };
  }

  // Network failure — use grace period.
  if (isWithinGrace(license, now)) {
    return { ok: true, offline: true, machineId, license };
  }
  return { needsReconnect: true, machineId, license };
}

module.exports = {
  getMachineId,
  getLocalLicense,
  saveLocalLicense,
  register,
  validate,
  checkLicenseGate,
  isCacheFresh,
  isWithinGrace,
  LICENSE_PATH,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  REVAL_MS,
  GRACE_MS
};
