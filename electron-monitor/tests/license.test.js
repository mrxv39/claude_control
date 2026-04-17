import { describe, it, expect } from 'vitest';

// Pure functions from lib/license.js — re-implemented here to avoid requiring
// electron at test time. Keep algorithms in lockstep with the source.

const REVAL_MS = 6 * 60 * 60 * 1000;
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function isCacheFresh(license, now) {
  if (!license || !license.lastValidatedAt) return false;
  const t = new Date(license.lastValidatedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return (now - t) < REVAL_MS;
}

function isWithinGrace(license, now) {
  if (!license || !license.lastValidatedAt) return false;
  const t = new Date(license.lastValidatedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return (now - t) < GRACE_MS;
}

describe('license isCacheFresh', () => {
  const now = new Date('2026-04-17T12:00:00Z').getTime();

  it('returns false for null license', () => {
    expect(isCacheFresh(null, now)).toBe(false);
  });

  it('returns false when lastValidatedAt is missing', () => {
    expect(isCacheFresh({ machineId: 'x' }, now)).toBe(false);
  });

  it('returns false for unparseable timestamp', () => {
    expect(isCacheFresh({ lastValidatedAt: 'not-a-date' }, now)).toBe(false);
  });

  it('returns true for 1h old cache', () => {
    const t = new Date(now - 60 * 60 * 1000).toISOString();
    expect(isCacheFresh({ lastValidatedAt: t }, now)).toBe(true);
  });

  it('returns false for 7h old cache (beyond 6h reval window)', () => {
    const t = new Date(now - 7 * 60 * 60 * 1000).toISOString();
    expect(isCacheFresh({ lastValidatedAt: t }, now)).toBe(false);
  });

  it('returns false for exactly 6h old cache (strict less-than)', () => {
    const t = new Date(now - REVAL_MS).toISOString();
    expect(isCacheFresh({ lastValidatedAt: t }, now)).toBe(false);
  });
});

describe('license isWithinGrace', () => {
  const now = new Date('2026-04-17T12:00:00Z').getTime();

  it('returns false for null license', () => {
    expect(isWithinGrace(null, now)).toBe(false);
  });

  it('returns true for 3-day old cache', () => {
    const t = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(isWithinGrace({ lastValidatedAt: t }, now)).toBe(true);
  });

  it('returns false for 8-day old cache', () => {
    const t = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(isWithinGrace({ lastValidatedAt: t }, now)).toBe(false);
  });

  it('grace window is longer than reval window', () => {
    expect(GRACE_MS).toBeGreaterThan(REVAL_MS);
  });
});

// Machine ID format check — parseable from a mocked `reg query` stdout
describe('license machineId parsing', () => {
  function extractMachineId(stdout) {
    const match = stdout.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
    return match ? match[1].trim().toLowerCase() : null;
  }

  it('extracts guid from reg output', () => {
    const stdout = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ABC123DE-4567-89AB-CDEF-0123456789AB\r\n\r\n';
    expect(extractMachineId(stdout)).toBe('abc123de-4567-89ab-cdef-0123456789ab');
  });

  it('returns null for missing guid', () => {
    expect(extractMachineId('some other text')).toBe(null);
  });

  it('handles extra whitespace', () => {
    const stdout = 'MachineGuid     REG_SZ     12345678-1234-1234-1234-123456789012  ';
    expect(extractMachineId(stdout)).toBe('12345678-1234-1234-1234-123456789012');
  });
});

// License file validation (same as source getLocalLicense)
describe('license validation', () => {
  function isValidLicense(data) {
    if (!data || typeof data !== 'object') return false;
    if (!data.machineId || !data.email) return false;
    return true;
  }

  it('rejects null', () => {
    expect(isValidLicense(null)).toBe(false);
  });

  it('rejects empty object', () => {
    expect(isValidLicense({})).toBe(false);
  });

  it('rejects missing email', () => {
    expect(isValidLicense({ machineId: 'x' })).toBe(false);
  });

  it('rejects missing machineId', () => {
    expect(isValidLicense({ email: 'x@y' })).toBe(false);
  });

  it('accepts complete license', () => {
    expect(isValidLicense({ machineId: 'x', email: 'x@y' })).toBe(true);
  });
});

// Gate decision matrix — integration of the 3 signals
describe('license gate decisions', () => {
  function decide(license, machineIdNow, fresh, graced, validateResult) {
    if (!license || license.machineId !== machineIdNow) return 'needsActivation';
    if (license.status === 'revoked') return 'revoked';
    if (license.status === 'active' && fresh) return 'ok';
    if (validateResult === null) return graced ? 'ok_offline' : 'needsReconnect';
    if (validateResult.status === 'revoked') return 'revoked';
    if (validateResult.status === 'unknown') return 'needsActivation';
    return 'ok';
  }

  it('first run: no license -> needsActivation', () => {
    expect(decide(null, 'm1', false, false, null)).toBe('needsActivation');
  });

  it('copied license.json (machineId mismatch) -> needsActivation', () => {
    expect(decide({ machineId: 'm2', status: 'active' }, 'm1', true, true, null)).toBe('needsActivation');
  });

  it('revoked cached status -> revoked', () => {
    expect(decide({ machineId: 'm1', status: 'revoked' }, 'm1', true, true, null)).toBe('revoked');
  });

  it('active + fresh cache -> ok (no network)', () => {
    expect(decide({ machineId: 'm1', status: 'active' }, 'm1', true, true, null)).toBe('ok');
  });

  it('active + stale + grace + offline -> ok_offline', () => {
    expect(decide({ machineId: 'm1', status: 'active' }, 'm1', false, true, null)).toBe('ok_offline');
  });

  it('stale cache + no grace + offline -> needsReconnect', () => {
    expect(decide({ machineId: 'm1', status: 'active' }, 'm1', false, false, null)).toBe('needsReconnect');
  });

  it('stale + backend revoke -> revoked', () => {
    expect(decide({ machineId: 'm1', status: 'active' }, 'm1', false, false, { status: 'revoked' })).toBe('revoked');
  });

  it('stale + backend unknown -> needsActivation', () => {
    expect(decide({ machineId: 'm1', status: 'active' }, 'm1', false, false, { status: 'unknown' })).toBe('needsActivation');
  });

  it('stale + backend active -> ok', () => {
    expect(decide({ machineId: 'm1', status: 'active' }, 'm1', false, false, { status: 'active' })).toBe('ok');
  });
});
