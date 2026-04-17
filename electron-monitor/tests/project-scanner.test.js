import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Tests for project-scanner.js logic.
 *
 * project-scanner.js discovers projects in configured directories and
 * detects their stack (node, rust, python, tauri, electron, etc.).
 * We test detectStack with real temp directories and scan filtering logic.
 */

const TEST_DIR = path.join(os.tmpdir(), `claudio-scanner-test-${Date.now()}`);

// --- STACK_MARKERS and SKIP (mirrored from project-scanner.js) ---
const STACK_MARKERS = [
  { file: 'Cargo.toml', stack: 'rust' },
  { file: 'pyproject.toml', stack: 'python' },
  { file: 'requirements.txt', stack: 'python' },
  { file: 'setup.py', stack: 'python' },
  { file: 'package.json', stack: 'node' },
  { file: 'go.mod', stack: 'go' },
  { file: 'pubspec.yaml', stack: 'dart' },
];

const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'target', '__pycache__', '.venv', 'venv', '.cache',
  'viejos', 'Nueva carpeta', 'Nueva carpeta (2)',
]);

// --- detectStack logic (mirrored from project-scanner.js:37-59) ---
function detectStack(projectPath) {
  const stacks = [];
  for (const { file, stack } of STACK_MARKERS) {
    if (fs.existsSync(path.join(projectPath, file))) {
      if (!stacks.includes(stack)) stacks.push(stack);
    }
  }
  if (stacks.includes('node') && fs.existsSync(path.join(projectPath, 'src-tauri'))) {
    stacks[stacks.indexOf('node')] = 'tauri';
    if (!stacks.includes('rust')) stacks.push('rust');
  }
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

// --- isValidProject logic (mirrored from project-scanner.js:93-99) ---
function isValidProject(fullPath) {
  if (!fs.existsSync(path.join(fullPath, '.git'))) return false;
  const hasManifest = STACK_MARKERS.some(m => fs.existsSync(path.join(fullPath, m.file)));
  const hasClaude = fs.existsSync(path.join(fullPath, 'CLAUDE.md'));
  return hasManifest || hasClaude;
}

// --- sort logic (mirrored from project-scanner.js:114-119) ---
function sortProjects(projects) {
  return [...projects].sort((a, b) => {
    if (!a.lastModified && !b.lastModified) return 0;
    if (!a.lastModified) return 1;
    if (!b.lastModified) return -1;
    return b.lastModified.localeCompare(a.lastModified);
  });
}

// Helper: create a project directory with files
function makeProject(name, files = {}) {
  const dir = path.join(TEST_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  // Always create .git dir
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(dir, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content || '');
  }
  return dir;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});


describe('project-scanner detectStack', () => {
  it('should detect node from package.json', () => {
    const dir = makeProject('my-node-app', {
      'package.json': '{"name":"test","dependencies":{}}',
    });
    expect(detectStack(dir)).toBe('node');
  });

  it('should detect rust from Cargo.toml', () => {
    const dir = makeProject('my-rust-app', {
      'Cargo.toml': '[package]\nname="test"',
    });
    expect(detectStack(dir)).toBe('rust');
  });

  it('should detect python from pyproject.toml', () => {
    const dir = makeProject('my-py-app', {
      'pyproject.toml': '[project]\nname="test"',
    });
    expect(detectStack(dir)).toBe('python');
  });

  it('should detect python from requirements.txt', () => {
    const dir = makeProject('my-py2', { 'requirements.txt': 'flask\n' });
    expect(detectStack(dir)).toBe('python');
  });

  it('should detect go from go.mod', () => {
    const dir = makeProject('my-go-app', { 'go.mod': 'module test\n' });
    expect(detectStack(dir)).toBe('go');
  });

  it('should detect dart from pubspec.yaml', () => {
    const dir = makeProject('my-dart-app', { 'pubspec.yaml': 'name: test\n' });
    expect(detectStack(dir)).toBe('dart');
  });

  it('should detect tauri (node + src-tauri)', () => {
    const dir = makeProject('my-tauri-app', {
      'package.json': '{"name":"test"}',
      'src-tauri/tauri.conf.json': '{}',
    });
    expect(detectStack(dir)).toBe('tauri+rust');
  });

  it('should detect electron from devDependencies', () => {
    const dir = makeProject('my-electron-app', {
      'package.json': '{"name":"test","devDependencies":{"electron":"^30.0.0"}}',
    });
    expect(detectStack(dir)).toBe('electron');
  });

  it('should detect electron from dependencies', () => {
    const dir = makeProject('my-electron-app2', {
      'package.json': '{"name":"test","dependencies":{"electron":"^30.0.0"}}',
    });
    expect(detectStack(dir)).toBe('electron');
  });

  it('should return unknown for no markers', () => {
    const dir = makeProject('empty-proj', {});
    expect(detectStack(dir)).toBe('unknown');
  });

  it('should combine multiple stacks with +', () => {
    const dir = makeProject('polyglot', {
      'package.json': '{"name":"test"}',
      'requirements.txt': 'django\n',
    });
    // python comes before node in STACK_MARKERS
    expect(detectStack(dir)).toBe('python+node');
  });

  it('should not duplicate python for pyproject.toml + requirements.txt', () => {
    const dir = makeProject('py-double', {
      'pyproject.toml': '[project]',
      'requirements.txt': 'flask\n',
    });
    expect(detectStack(dir)).toBe('python');
  });

  it('should handle malformed package.json gracefully', () => {
    const dir = makeProject('bad-pkg', {
      'package.json': 'not json at all',
    });
    // Should still detect node (from package.json existing), just not refine to electron
    expect(detectStack(dir)).toBe('node');
  });
});

describe('project-scanner isValidProject', () => {
  it('should accept project with .git + package.json', () => {
    const dir = makeProject('valid-node', { 'package.json': '{}' });
    expect(isValidProject(dir)).toBe(true);
  });

  it('should accept project with .git + CLAUDE.md only', () => {
    const dir = makeProject('claude-only', { 'CLAUDE.md': '# Project' });
    expect(isValidProject(dir)).toBe(true);
  });

  it('should reject dir without .git', () => {
    const dir = path.join(TEST_DIR, 'no-git');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(isValidProject(dir)).toBe(false);
  });

  it('should reject dir with .git but no manifest or CLAUDE.md', () => {
    const dir = makeProject('git-only', {});
    expect(isValidProject(dir)).toBe(false);
  });
});

describe('project-scanner SKIP set', () => {
  it('should skip node_modules', () => {
    expect(SKIP.has('node_modules')).toBe(true);
  });

  it('should skip .git', () => {
    expect(SKIP.has('.git')).toBe(true);
  });

  it('should skip build output dirs', () => {
    expect(SKIP.has('dist')).toBe(true);
    expect(SKIP.has('build')).toBe(true);
    expect(SKIP.has('.next')).toBe(true);
  });

  it('should skip user junk dirs', () => {
    expect(SKIP.has('viejos')).toBe(true);
    expect(SKIP.has('Nueva carpeta')).toBe(true);
  });

  it('should not skip regular project names', () => {
    expect(SKIP.has('my-app')).toBe(false);
    expect(SKIP.has('api-server')).toBe(false);
  });
});

describe('project-scanner sortProjects', () => {
  it('should sort most recent first', () => {
    const projects = [
      { name: 'old', lastModified: '2026-01-01T00:00:00.000Z' },
      { name: 'new', lastModified: '2026-04-17T00:00:00.000Z' },
      { name: 'mid', lastModified: '2026-03-01T00:00:00.000Z' },
    ];
    const sorted = sortProjects(projects);
    expect(sorted.map(p => p.name)).toEqual(['new', 'mid', 'old']);
  });

  it('should put null lastModified at end', () => {
    const projects = [
      { name: 'unknown', lastModified: null },
      { name: 'known', lastModified: '2026-04-01T00:00:00.000Z' },
    ];
    const sorted = sortProjects(projects);
    expect(sorted[0].name).toBe('known');
    expect(sorted[1].name).toBe('unknown');
  });

  it('should handle all nulls', () => {
    const projects = [
      { name: 'a', lastModified: null },
      { name: 'b', lastModified: null },
    ];
    const sorted = sortProjects(projects);
    expect(sorted).toHaveLength(2);
  });

  it('should handle empty array', () => {
    expect(sortProjects([])).toEqual([]);
  });

  it('should not mutate original array', () => {
    const projects = [
      { name: 'b', lastModified: '2026-02-01T00:00:00.000Z' },
      { name: 'a', lastModified: '2026-04-01T00:00:00.000Z' },
    ];
    sortProjects(projects);
    expect(projects[0].name).toBe('b');
  });
});
