/**
 * project-analyzer.js — Local health checks for projects (zero API cost).
 *
 * Checks:
 *   - Has CLAUDE.md?
 *   - Has .gitignore?
 *   - Has tests directory?
 *   - Git working tree clean?
 *   - Lock file fresher than manifest? (deps up to date)
 *   - Last commit age (days)
 *
 * Returns a score 1-10 and check results per project.
 */

/**
 * @typedef {Object} HealthChecks
 * @property {boolean} hasClaude - Has CLAUDE.md
 * @property {boolean} hasGitignore - Has .gitignore
 * @property {boolean} hasTests - Has a test directory
 * @property {boolean|null} gitClean - Working tree clean (null = unknown)
 * @property {boolean|null} depsOk - Lock file fresher than manifest (null = no pair found)
 * @property {number|null} lastCommitDays - Days since last commit (null = unknown)
 */

/**
 * @typedef {Object} AnalysisResult
 * @property {HealthChecks} checks
 * @property {number} score - 1-10 health score
 * @property {string[]} suggestions - Human-readable improvement suggestions
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TEST_DIRS = ['test', 'tests', '__tests__', 'spec', 'test-utils'];

/**
 * @param {string} base
 * @param {...string} segments
 * @returns {boolean}
 */
function fileExists(base, ...segments) {
  return fs.existsSync(path.join(base, ...segments));
}

/**
 * Check if git working tree is clean.
 * @param {string} projectPath
 * @returns {Promise<boolean|null>} true=clean, false=dirty, null=error
 */
function gitClean(projectPath) {
  return new Promise(resolve => {
    execFile('git', ['status', '--porcelain'], { cwd: projectPath, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null); // can't determine
      resolve(stdout.trim() === '');
    });
  });
}

/**
 * Get days since the last git commit.
 * @param {string} projectPath
 * @returns {Promise<number|null>}
 */
function lastCommitDays(projectPath) {
  return new Promise(resolve => {
    execFile('git', ['log', '-1', '--format=%ct'], { cwd: projectPath, timeout: 5000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      const ts = parseInt(stdout.trim(), 10);
      if (isNaN(ts)) return resolve(null);
      const days = Math.floor((Date.now() / 1000 - ts) / 86400);
      resolve(days);
    });
  });
}

/**
 * Check if lock file is newer than manifest (deps up to date).
 * @param {string} projectPath
 * @returns {boolean|null} true=up to date, false=stale, null=no manifest+lock pair
 */
function depsUpToDate(projectPath) {
  // Check if lock file is newer than manifest
  const pairs = [
    ['package.json', 'package-lock.json'],
    ['package.json', 'yarn.lock'],
    ['package.json', 'pnpm-lock.yaml'],
    ['Cargo.toml', 'Cargo.lock'],
    ['pyproject.toml', 'poetry.lock'],
  ];
  for (const [manifest, lock] of pairs) {
    const mPath = path.join(projectPath, manifest);
    const lPath = path.join(projectPath, lock);
    if (fs.existsSync(mPath) && fs.existsSync(lPath)) {
      try {
        const mStat = fs.statSync(mPath);
        const lStat = fs.statSync(lPath);
        return lStat.mtimeMs >= mStat.mtimeMs;
      } catch { return null; }
    }
  }
  return null; // no manifest+lock pair found
}

/**
 * Analyze a single project's health.
 * @param {{name: string, path: string}} project
 * @returns {Promise<AnalysisResult>}
 */
async function analyze(project) {
  const p = project.path;

  const checks = {
    hasClaude: fileExists(p, 'CLAUDE.md'),
    hasGitignore: fileExists(p, '.gitignore'),
    hasTests: TEST_DIRS.some(d => fileExists(p, d)),
    gitClean: await gitClean(p),
    depsOk: depsUpToDate(p),
    lastCommitDays: await lastCommitDays(p),
  };

  // Score calculation (out of 10)
  let score = 5; // baseline
  if (checks.hasClaude) score += 1; else score -= 1;
  if (checks.hasGitignore) score += 0.5; else score -= 0.5;
  if (checks.hasTests) score += 1.5; else score -= 1;
  if (checks.gitClean === true) score += 0.5; else if (checks.gitClean === false) score -= 0.5;
  if (checks.depsOk === true) score += 0.5; else if (checks.depsOk === false) score -= 0.5;
  // Penalize stale projects (no commit in 30+ days)
  if (checks.lastCommitDays !== null && checks.lastCommitDays > 30) score -= 0.5;
  // Bonus for very active (commit in last 7 days)
  if (checks.lastCommitDays !== null && checks.lastCommitDays <= 7) score += 0.5;

  score = Math.max(1, Math.min(10, Math.round(score)));

  // Generate suggestions
  const suggestions = [];
  if (!checks.hasClaude) suggestions.push('Crear CLAUDE.md con arquitectura y convenciones');
  if (!checks.hasGitignore) suggestions.push('Añadir .gitignore');
  if (!checks.hasTests) suggestions.push('Añadir directorio de tests');
  if (checks.gitClean === false) suggestions.push('Hay cambios sin commitear');
  if (checks.depsOk === false) suggestions.push('Lock file desactualizado (deps cambiaron)');
  if (checks.lastCommitDays !== null && checks.lastCommitDays > 60) {
    suggestions.push(`Último commit hace ${checks.lastCommitDays} días — ¿proyecto abandonado?`);
  }

  return { checks, score, suggestions };
}

/**
 * Analyze all projects.
 * @param {Array<{name: string, path: string, stack: string, lastModified: string|null}>} projects
 * @returns {Promise<Object<string, {path: string, stack: string, lastModified: string|null, lastAnalysis: string} & AnalysisResult>>}
 */
async function analyzeAll(projects) {
  const results = {};
  for (const project of projects) {
    try {
      const analysis = await analyze(project);
      results[project.name] = {
        path: project.path,
        stack: project.stack,
        lastModified: project.lastModified,
        lastAnalysis: new Date().toISOString(),
        ...analysis
      };
    } catch {
      results[project.name] = {
        path: project.path,
        stack: project.stack,
        lastModified: project.lastModified,
        lastAnalysis: new Date().toISOString(),
        checks: {},
        score: 5,
        suggestions: ['Error al analizar este proyecto']
      };
    }
  }
  return results;
}

module.exports = { analyze, analyzeAll };
