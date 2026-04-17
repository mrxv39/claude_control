import { describe, it, expect } from 'vitest';

/**
 * Tests for overlay-manager.js sync logic.
 *
 * syncOverlays() and syncSkillButtons() manage Maps of overlays keyed by HWND.
 * They create/update/remove entries as sessions change. We reimplement the
 * stateful sync logic here to verify correctness without Electron BrowserWindow.
 */

// Reimplement syncOverlays logic (mirrors overlay-manager.js)
function createOverlaySync() {
  const overlays = new Map(); // hwnd -> { label, status }
  const validHwnds = new Set(); // simulate IsWindow()

  function setValidHwnds(hwnds) {
    validHwnds.clear();
    hwnds.forEach(h => validHwnds.add(h));
  }

  function syncOverlays(sessions) {
    const live = new Map();
    for (const s of sessions) {
      if (s.hwnd && validHwnds.has(Number(s.hwnd))) {
        live.set(Number(s.hwnd), { label: s.project || '?', status: s.status || 'IDLE' });
      }
    }
    // Remove dead overlays
    for (const h of overlays.keys()) {
      if (!live.has(h)) overlays.delete(h);
    }
    // Create or update
    for (const [h, data] of live) {
      const info = overlays.get(h);
      if (!info) {
        overlays.set(h, { label: data.label, status: data.status, created: true });
      } else if (info.label !== data.label || info.status !== data.status) {
        info.label = data.label;
        info.status = data.status;
        info.updated = true;
      }
    }
  }

  return { syncOverlays, overlays, setValidHwnds };
}

// Reimplement syncSkillButtons logic (mirrors overlay-manager.js)
function createSkillSync() {
  const skillOverlays = new Map(); // hwnd -> { skill, project, projectPath }
  const validHwnds = new Set();

  function setValidHwnds(hwnds) {
    validHwnds.clear();
    hwnds.forEach(h => validHwnds.add(h));
  }

  function syncSkillButtons(sessions, recommendations) {
    const live = new Map();
    for (const s of sessions) {
      if (!s.hwnd || !validHwnds.has(Number(s.hwnd))) continue;
      const rec = recommendations[s.project];
      if (rec) {
        live.set(Number(s.hwnd), { project: s.project, skill: rec.skill, projectPath: rec.projectPath });
      }
    }
    // Remove stale
    for (const h of skillOverlays.keys()) {
      if (!live.has(h)) skillOverlays.delete(h);
    }
    // Create or update
    for (const [h, data] of live) {
      const info = skillOverlays.get(h);
      if (!info) {
        skillOverlays.set(h, { skill: data.skill, project: data.project, projectPath: data.projectPath });
      } else if (info.skill !== data.skill) {
        info.skill = data.skill;
        info.project = data.project;
        info.projectPath = data.projectPath;
      }
    }
  }

  return { syncSkillButtons, skillOverlays, setValidHwnds };
}

describe('syncOverlays', () => {
  it('creates overlay for new session with valid HWND', () => {
    const s = createOverlaySync();
    s.setValidHwnds([100]);
    s.syncOverlays([{ hwnd: 100, project: 'test-proj', status: 'BUSY' }]);
    expect(s.overlays.size).toBe(1);
    expect(s.overlays.get(100)).toMatchObject({ label: 'test-proj', status: 'BUSY' });
  });

  it('ignores session with no HWND', () => {
    const s = createOverlaySync();
    s.syncOverlays([{ hwnd: 0, project: 'test', status: 'BUSY' }]);
    expect(s.overlays.size).toBe(0);
  });

  it('ignores session with invalid HWND', () => {
    const s = createOverlaySync();
    s.setValidHwnds([100]); // 200 is not valid
    s.syncOverlays([{ hwnd: 200, project: 'test', status: 'BUSY' }]);
    expect(s.overlays.size).toBe(0);
  });

  it('removes overlay when session disappears', () => {
    const s = createOverlaySync();
    s.setValidHwnds([100]);
    s.syncOverlays([{ hwnd: 100, project: 'test', status: 'BUSY' }]);
    expect(s.overlays.size).toBe(1);
    s.syncOverlays([]); // session gone
    expect(s.overlays.size).toBe(0);
  });

  it('removes overlay when HWND becomes invalid', () => {
    const s = createOverlaySync();
    s.setValidHwnds([100]);
    s.syncOverlays([{ hwnd: 100, project: 'test', status: 'BUSY' }]);
    s.setValidHwnds([]); // HWND invalidated
    s.syncOverlays([{ hwnd: 100, project: 'test', status: 'BUSY' }]);
    expect(s.overlays.size).toBe(0);
  });

  it('updates overlay when status changes', () => {
    const s = createOverlaySync();
    s.setValidHwnds([100]);
    s.syncOverlays([{ hwnd: 100, project: 'test', status: 'BUSY' }]);
    s.syncOverlays([{ hwnd: 100, project: 'test', status: 'WAITING' }]);
    expect(s.overlays.get(100).status).toBe('WAITING');
    expect(s.overlays.get(100).updated).toBe(true);
  });

  it('updates overlay when label changes', () => {
    const s = createOverlaySync();
    s.setValidHwnds([100]);
    s.syncOverlays([{ hwnd: 100, project: 'proj-a', status: 'BUSY' }]);
    s.syncOverlays([{ hwnd: 100, project: 'proj-b', status: 'BUSY' }]);
    expect(s.overlays.get(100).label).toBe('proj-b');
  });

  it('does not update overlay if nothing changed', () => {
    const s = createOverlaySync();
    s.setValidHwnds([100]);
    s.syncOverlays([{ hwnd: 100, project: 'test', status: 'BUSY' }]);
    const ref = s.overlays.get(100);
    ref.updated = false; // reset flag
    s.syncOverlays([{ hwnd: 100, project: 'test', status: 'BUSY' }]);
    expect(ref.updated).toBe(false); // no unnecessary update
  });

  it('tracks multiple overlays simultaneously', () => {
    const s = createOverlaySync();
    s.setValidHwnds([100, 200, 300]);
    s.syncOverlays([
      { hwnd: 100, project: 'a', status: 'BUSY' },
      { hwnd: 200, project: 'b', status: 'WAITING' },
      { hwnd: 300, project: 'c', status: 'IDLE' },
    ]);
    expect(s.overlays.size).toBe(3);
    expect(s.overlays.get(200).status).toBe('WAITING');
  });

  it('uses "?" as default label when project is missing', () => {
    const s = createOverlaySync();
    s.setValidHwnds([100]);
    s.syncOverlays([{ hwnd: 100, status: 'BUSY' }]);
    expect(s.overlays.get(100).label).toBe('?');
  });

  it('defaults to IDLE status when status is missing', () => {
    const s = createOverlaySync();
    s.setValidHwnds([100]);
    s.syncOverlays([{ hwnd: 100, project: 'test' }]);
    expect(s.overlays.get(100).status).toBe('IDLE');
  });
});

describe('syncSkillButtons', () => {
  it('creates skill overlay for session with recommendation', () => {
    const s = createSkillSync();
    s.setValidHwnds([100]);
    const recs = { myproj: { skill: 'add-tests', projectPath: '/path' } };
    s.syncSkillButtons([{ hwnd: 100, project: 'myproj' }], recs);
    expect(s.skillOverlays.size).toBe(1);
    expect(s.skillOverlays.get(100).skill).toBe('add-tests');
  });

  it('does not create skill overlay without recommendation', () => {
    const s = createSkillSync();
    s.setValidHwnds([100]);
    s.syncSkillButtons([{ hwnd: 100, project: 'myproj' }], {});
    expect(s.skillOverlays.size).toBe(0);
  });

  it('removes skill overlay when recommendation disappears', () => {
    const s = createSkillSync();
    s.setValidHwnds([100]);
    const recs = { myproj: { skill: 'add-tests', projectPath: '/path' } };
    s.syncSkillButtons([{ hwnd: 100, project: 'myproj' }], recs);
    expect(s.skillOverlays.size).toBe(1);
    s.syncSkillButtons([{ hwnd: 100, project: 'myproj' }], {}); // no rec
    expect(s.skillOverlays.size).toBe(0);
  });

  it('updates skill when recommendation changes', () => {
    const s = createSkillSync();
    s.setValidHwnds([100]);
    s.syncSkillButtons([{ hwnd: 100, project: 'p' }], { p: { skill: 'add-tests', projectPath: '/x' } });
    expect(s.skillOverlays.get(100).skill).toBe('add-tests');
    s.syncSkillButtons([{ hwnd: 100, project: 'p' }], { p: { skill: 'simplify', projectPath: '/x' } });
    expect(s.skillOverlays.get(100).skill).toBe('simplify');
  });

  it('ignores sessions with invalid HWND', () => {
    const s = createSkillSync();
    s.setValidHwnds([100]); // 200 is not valid
    s.syncSkillButtons([{ hwnd: 200, project: 'p' }], { p: { skill: 'x', projectPath: '/x' } });
    expect(s.skillOverlays.size).toBe(0);
  });
});
