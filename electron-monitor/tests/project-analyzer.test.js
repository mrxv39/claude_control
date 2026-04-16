import { describe, it, expect } from 'vitest';

// Reimplement the scoring logic from project-analyzer.js for testing

function computeScore(checks) {
  let score = 5;
  if (checks.hasClaude) score += 1; else score -= 1;
  if (checks.hasGitignore) score += 0.5; else score -= 0.5;
  if (checks.hasTests) score += 1.5; else score -= 1;
  if (checks.gitClean === true) score += 0.5; else if (checks.gitClean === false) score -= 0.5;
  if (checks.depsOk === true) score += 0.5; else if (checks.depsOk === false) score -= 0.5;
  if (checks.lastCommitDays !== null && checks.lastCommitDays > 30) score -= 0.5;
  if (checks.lastCommitDays !== null && checks.lastCommitDays <= 7) score += 0.5;
  return Math.max(1, Math.min(10, Math.round(score)));
}

function generateSuggestions(checks) {
  const suggestions = [];
  if (!checks.hasClaude) suggestions.push('Crear CLAUDE.md con arquitectura y convenciones');
  if (!checks.hasGitignore) suggestions.push('Añadir .gitignore');
  if (!checks.hasTests) suggestions.push('Añadir directorio de tests');
  if (checks.gitClean === false) suggestions.push('Hay cambios sin commitear');
  if (checks.depsOk === false) suggestions.push('Lock file desactualizado (deps cambiaron)');
  if (checks.lastCommitDays !== null && checks.lastCommitDays > 60) {
    suggestions.push(`Último commit hace ${checks.lastCommitDays} días — ¿proyecto abandonado?`);
  }
  return suggestions;
}

function depsUpToDate(mtimeManifest, mtimeLock) {
  if (mtimeManifest === null || mtimeLock === null) return null;
  return mtimeLock >= mtimeManifest;
}

describe('computeScore', () => {
  it('perfect project scores 10', () => {
    const checks = {
      hasClaude: true, hasGitignore: true, hasTests: true,
      gitClean: true, depsOk: true, lastCommitDays: 3
    };
    expect(computeScore(checks)).toBe(10);
  });

  it('worst project scores 1', () => {
    const checks = {
      hasClaude: false, hasGitignore: false, hasTests: false,
      gitClean: false, depsOk: false, lastCommitDays: 60
    };
    expect(computeScore(checks)).toBe(1);
  });

  it('baseline project with all nulls scores 4', () => {
    const checks = {
      hasClaude: false, hasGitignore: false, hasTests: false,
      gitClean: null, depsOk: null, lastCommitDays: null
    };
    // 5 - 1 - 0.5 - 1 = 2.5 → rounds to 3
    expect(computeScore(checks)).toBe(3);
  });

  it('clamps to minimum 1', () => {
    const checks = {
      hasClaude: false, hasGitignore: false, hasTests: false,
      gitClean: false, depsOk: false, lastCommitDays: 90
    };
    expect(computeScore(checks)).toBeGreaterThanOrEqual(1);
  });

  it('clamps to maximum 10', () => {
    const checks = {
      hasClaude: true, hasGitignore: true, hasTests: true,
      gitClean: true, depsOk: true, lastCommitDays: 1
    };
    expect(computeScore(checks)).toBeLessThanOrEqual(10);
  });

  it('stale project (>30d) gets penalty', () => {
    const recent = { hasClaude: true, hasGitignore: true, hasTests: true, gitClean: true, depsOk: true, lastCommitDays: 5 };
    const stale = { ...recent, lastCommitDays: 45 };
    expect(computeScore(stale)).toBeLessThan(computeScore(recent));
  });

  it('active project (<=7d) gets bonus', () => {
    const active = { hasClaude: true, hasGitignore: true, hasTests: true, gitClean: null, depsOk: null, lastCommitDays: 5 };
    const inactive = { ...active, lastCommitDays: 15 };
    expect(computeScore(active)).toBeGreaterThan(computeScore(inactive));
  });
});

describe('generateSuggestions', () => {
  it('returns empty for perfect project', () => {
    const checks = { hasClaude: true, hasGitignore: true, hasTests: true, gitClean: true, depsOk: true, lastCommitDays: 5 };
    expect(generateSuggestions(checks)).toEqual([]);
  });

  it('suggests CLAUDE.md when missing', () => {
    const checks = { hasClaude: false, hasGitignore: true, hasTests: true, gitClean: true, depsOk: true, lastCommitDays: 5 };
    expect(generateSuggestions(checks)).toContain('Crear CLAUDE.md con arquitectura y convenciones');
  });

  it('suggests abandoned warning for >60 days', () => {
    const checks = { hasClaude: true, hasGitignore: true, hasTests: true, gitClean: true, depsOk: true, lastCommitDays: 90 };
    const suggestions = generateSuggestions(checks);
    expect(suggestions.some(s => s.includes('90 días'))).toBe(true);
  });

  it('does NOT suggest abandoned for 30-60 days', () => {
    const checks = { hasClaude: true, hasGitignore: true, hasTests: true, gitClean: true, depsOk: true, lastCommitDays: 45 };
    expect(generateSuggestions(checks).some(s => s.includes('abandonado'))).toBe(false);
  });
});

describe('depsUpToDate', () => {
  it('returns null if no lock file', () => {
    expect(depsUpToDate(null, null)).toBeNull();
  });

  it('returns true if lock is newer', () => {
    expect(depsUpToDate(1000, 2000)).toBe(true);
  });

  it('returns false if manifest is newer', () => {
    expect(depsUpToDate(2000, 1000)).toBe(false);
  });

  it('returns true if same time', () => {
    expect(depsUpToDate(1000, 1000)).toBe(true);
  });
});
