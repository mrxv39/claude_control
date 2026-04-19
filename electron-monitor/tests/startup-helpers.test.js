import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// startup-helpers.js requires `electron` (net) in `init()`, so direct import
// pulls in Electron at test time. We test the pure pieces — file resolution,
// statusLine detection, hook detection — by mirroring their algorithms, which
// is the same pattern used by license.test.js and telemetry.test.js.

// ---- resolveScript mirror (from startup-helpers.js:16-20) ----
function makeResolveScript(appRoot, resourcesPath) {
  return function resolveScript(name) {
    const dev = path.join(appRoot, name);
    if (fs.existsSync(dev)) return dev;
    return path.join(resourcesPath, name);
  };
}

// ---- setupStatusLine decision mirror (from startup-helpers.js:37-48) ----
// Returns true when setupStatusLine would SKIP (already configured correctly).
function alreadyConfigured(settingsStatusLine) {
  if (!settingsStatusLine) return false;
  return (
    typeof settingsStatusLine === 'string' &&
    settingsStatusLine.includes('statusline-writer') &&
    !settingsStatusLine.includes('\\\\\\\\')
  );
}

// ---- checkHookSetup mirror (from startup-helpers.js:50-60) ----
function hookIsMissing(settingsContent) {
  if (settingsContent === null) return true; // file doesn't exist
  return !settingsContent.includes('claude-state-hook');
}

describe('resolveScript', () => {
  let tmpDir, appRoot, resourcesPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-startup-'));
    appRoot = path.join(tmpDir, 'app');
    resourcesPath = path.join(tmpDir, 'res');
    fs.mkdirSync(appRoot);
    fs.mkdirSync(resourcesPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves to the appRoot path when the script exists there (dev mode)', () => {
    const devPath = path.join(appRoot, 'get-sessions.ps1');
    fs.writeFileSync(devPath, '# dev');
    const resolve = makeResolveScript(appRoot, resourcesPath);
    expect(resolve('get-sessions.ps1')).toBe(devPath);
  });

  it('falls back to resourcesPath when not in appRoot (packaged mode)', () => {
    const resPath = path.join(resourcesPath, 'get-sessions.ps1');
    fs.writeFileSync(resPath, '# packaged');
    const resolve = makeResolveScript(appRoot, resourcesPath);
    expect(resolve('get-sessions.ps1')).toBe(resPath);
  });

  it('prefers appRoot when both paths exist', () => {
    fs.writeFileSync(path.join(appRoot, 'x.ps1'), 'dev');
    fs.writeFileSync(path.join(resourcesPath, 'x.ps1'), 'pkg');
    const resolve = makeResolveScript(appRoot, resourcesPath);
    expect(resolve('x.ps1')).toBe(path.join(appRoot, 'x.ps1'));
  });

  it('returns the resourcesPath fallback even if it does not exist', () => {
    const resolve = makeResolveScript(appRoot, resourcesPath);
    const out = resolve('missing.ps1');
    expect(out).toBe(path.join(resourcesPath, 'missing.ps1'));
  });
});

describe('setupStatusLine / alreadyConfigured', () => {
  it('returns false when no statusLine is set', () => {
    expect(alreadyConfigured(undefined)).toBe(false);
    expect(alreadyConfigured(null)).toBe(false);
    expect(alreadyConfigured('')).toBe(false);
  });

  it('returns false when statusLine does not reference statusline-writer', () => {
    expect(alreadyConfigured('node other-tool.js')).toBe(false);
  });

  it('returns true for a correctly-set statusLine', () => {
    expect(alreadyConfigured('node "C:\\path\\to\\statusline-writer.js"')).toBe(true);
  });

  it('returns false when statusLine has the over-escaped backslashes bug', () => {
    // 8 literal backslashes = JSON-broken path from a past regression.
    const bad = 'node "C:\\\\\\\\path\\\\\\\\statusline-writer.js"';
    expect(alreadyConfigured(bad)).toBe(false);
  });

  it('returns false for non-string statusLine (object form without normalization)', () => {
    expect(alreadyConfigured({ type: 'command', command: 'node x.js' })).toBe(false);
  });
});

describe('checkHookSetup / hookIsMissing', () => {
  it('reports missing when settings file does not exist', () => {
    expect(hookIsMissing(null)).toBe(true);
  });

  it('reports missing when content has no claude-state-hook reference', () => {
    expect(hookIsMissing('{"theme":"dark"}')).toBe(true);
  });

  it('reports present when content mentions claude-state-hook', () => {
    const settings = '{"hooks":{"UserPromptSubmit":[{"command":"powershell claude-state-hook.ps1"}]}}';
    expect(hookIsMissing(settings)).toBe(false);
  });

  it('reports present even if reference is in a comment-like payload', () => {
    expect(hookIsMissing('# claude-state-hook installed')).toBe(false);
  });

  it('reports missing for empty content', () => {
    expect(hookIsMissing('')).toBe(true);
  });
});
