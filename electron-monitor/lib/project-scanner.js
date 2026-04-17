/**
 * project-scanner.js — Discovers projects across configured directories.
 *
 * A directory is a "project" if it contains:
 *   - .git/  (git repo)
 *   AND at least one of:
 *   - package.json (Node.js)
 *   - Cargo.toml (Rust)
 *   - pyproject.toml / requirements.txt / setup.py (Python)
 *   - CLAUDE.md (any project using Claude Code)
 *
 * Returns: [{ name, path, stack, lastModified }]
 */

/**
 * @typedef {Object} ScannedProject
 * @property {string} name - Directory name
 * @property {string} path - Absolute path
 * @property {string} stack - Detected stack (e.g. 'node', 'tauri+rust', 'python')
 * @property {string|null} lastModified - ISO timestamp of last commit
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/** @type {Array<{file: string, stack: string}>} */
const STACK_MARKERS = [
  { file: 'Cargo.toml', stack: 'rust' },
  { file: 'pyproject.toml', stack: 'python' },
  { file: 'requirements.txt', stack: 'python' },
  { file: 'setup.py', stack: 'python' },
  { file: 'package.json', stack: 'node' },
  { file: 'go.mod', stack: 'go' },
  { file: 'pubspec.yaml', stack: 'dart' },
];

// Subdirectories to skip
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'target', '__pycache__', '.venv', 'venv', '.cache',
  'viejos', 'Nueva carpeta', 'Nueva carpeta (2)',
]);

/**
 * Detect the tech stack of a project by checking manifest files.
 * @param {string} projectPath - Absolute path to project root
 * @returns {string} Stack identifier (e.g. 'node', 'tauri+rust', 'python', 'unknown')
 */
function detectStack(projectPath) {
  const stacks = [];
  for (const { file, stack } of STACK_MARKERS) {
    if (fs.existsSync(path.join(projectPath, file))) {
      if (!stacks.includes(stack)) stacks.push(stack);
    }
  }
  // Refine node → tauri if src-tauri exists
  if (stacks.includes('node') && fs.existsSync(path.join(projectPath, 'src-tauri'))) {
    stacks[stacks.indexOf('node')] = 'tauri';
    if (!stacks.includes('rust')) stacks.push('rust');
  }
  // Refine node → electron if electron in package.json deps
  if (stacks.includes('node')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps.electron) {
        stacks[stacks.indexOf('node')] = 'electron';
      }
    } catch {}
  }
  return stacks.length ? stacks.join('+') : 'unknown';
}

/**
 * Get the ISO timestamp of the most recent git commit.
 * @param {string} projectPath
 * @returns {Promise<string|null>} ISO date string or null
 */
function lastCommitTime(projectPath) {
  return new Promise(resolve => {
    execFile('git', ['log', '-1', '--format=%ct'], { cwd: projectPath, timeout: 5000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      const ts = parseInt(stdout.trim(), 10);
      resolve(isNaN(ts) ? null : new Date(ts * 1000).toISOString());
    });
  });
}

/**
 * Scan configured directories for projects.
 * Only scans one level deep (direct children of each projectDir).
 * @param {string[]} projectDirs - Base directories to scan
 * @returns {Promise<ScannedProject[]>} Projects sorted by last commit (most recent first)
 */
async function scan(projectDirs) {
  const results = [];

  for (const baseDir of projectDirs) {
    if (!fs.existsSync(baseDir)) continue;

    let entries;
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP.has(entry.name)) continue;

      const fullPath = path.join(baseDir, entry.name);

      // Must have .git
      if (!fs.existsSync(path.join(fullPath, '.git'))) continue;

      // Must have at least one manifest or CLAUDE.md
      const hasManifest = STACK_MARKERS.some(m => fs.existsSync(path.join(fullPath, m.file)));
      const hasClaude = fs.existsSync(path.join(fullPath, 'CLAUDE.md'));
      if (!hasManifest && !hasClaude) continue;

      const stack = detectStack(fullPath);
      const lastModified = await lastCommitTime(fullPath);

      results.push({
        name: entry.name,
        path: fullPath,
        stack,
        lastModified
      });
    }
  }

  // Sort by last modified (most recent first), nulls at end
  results.sort((a, b) => {
    if (!a.lastModified && !b.lastModified) return 0;
    if (!a.lastModified) return 1;
    if (!b.lastModified) return -1;
    return b.lastModified.localeCompare(a.lastModified);
  });

  return results;
}

module.exports = { scan, detectStack };
