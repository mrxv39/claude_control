import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEST_BASE = path.join(os.tmpdir(), `claudio-test-sa-${Date.now()}`);

function makeProject(name, files = {}) {
  const dir = path.join(TEST_BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
  return dir;
}

// Import the real heuristicAnalyze (no Electron/FFI dependencies)
const { heuristicAnalyze, ALL_SKILLS } = require('../lib/skill-analyzer');

beforeEach(() => {
  fs.mkdirSync(TEST_BASE, { recursive: true });
});

afterAll(() => {
  try { fs.rmSync(TEST_BASE, { recursive: true, force: true }); } catch {}
});

describe('skill-analyzer heuristicAnalyze', () => {
  it('returns all skills with boolean values', () => {
    const dir = makeProject('empty-proj', {});
    const result = heuristicAnalyze(dir, null);
    expect(result.method).toBe('heuristic');
    expect(result.analyzedAt).toBeDefined();
    for (const skill of ALL_SKILLS) {
      expect(typeof result.skills[skill]).toBe('boolean');
    }
  });

  it('always marks audit-claude-md and git-cleanup as applicable', () => {
    const dir = makeProject('minimal', {});
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['audit-claude-md']).toBe(true);
    expect(result.skills['git-cleanup']).toBe(true);
  });

  it('detects Node.js project (package.json)', () => {
    const dir = makeProject('node-proj', {
      'package.json': JSON.stringify({ name: 'test', dependencies: {} })
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['dep-update']).toBe(true);
    expect(result.skills['add-tests']).toBe(true);
    expect(result.skills['simplify']).toBe(true);
  });

  it('detects TypeScript project', () => {
    const dir = makeProject('ts-proj', {
      'package.json': JSON.stringify({ name: 'test', dependencies: {} }),
      'src/index.ts': 'export const x = 1;'
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['fix-types']).toBe(true);
  });

  it('detects React/UI project', () => {
    const dir = makeProject('react-proj', {
      'package.json': JSON.stringify({
        name: 'test',
        dependencies: { react: '^18.0.0' },
        scripts: { dev: 'vite' }
      }),
      'src/App.tsx': 'export default function App() { return <div/>; }'
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['ui-polish']).toBe(true);
    expect(result.skills['frontend-design']).toBe(true);
    expect(result.skills['webapp-testing']).toBe(true);
  });

  it('detects Supabase project', () => {
    const dir = makeProject('supa-proj', {
      'package.json': JSON.stringify({
        name: 'test',
        dependencies: { '@supabase/supabase-js': '^2.0.0' }
      })
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['supabase-audit']).toBe(true);
    expect(result.skills['security-review']).toBe(true);
  });

  it('detects Supabase by directory', () => {
    const dir = makeProject('supa-dir', {
      'supabase/config.toml': 'project_id = "test"'
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['supabase-audit']).toBe(true);
  });

  it('detects security-sensitive project (crypto deps)', () => {
    const dir = makeProject('crypto-proj', {
      'package.json': JSON.stringify({
        name: 'test',
        dependencies: { bcrypt: '^5.0.0', jsonwebtoken: '^9.0.0' }
      })
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['security-review']).toBe(true);
    expect(result.skills['trailofbits-security']).toBe(true);
  });

  it('detects financial project (stripe)', () => {
    const dir = makeProject('stripe-proj', {
      'package.json': JSON.stringify({
        name: 'test',
        dependencies: { stripe: '^12.0.0' }
      })
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['trailofbits-security']).toBe(true);
  });

  it('detects Python project', () => {
    const dir = makeProject('py-proj', {
      'main.py': 'print("hello")',
      'requirements.txt': 'flask==2.0.0'
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['fix-types']).toBe(true);
    expect(result.skills['security-review']).toBe(true);
  });

  it('does not mark webapp-testing for projects without dev script', () => {
    const dir = makeProject('no-dev', {
      'package.json': JSON.stringify({
        name: 'test',
        dependencies: { react: '^18.0.0' }
      }),
      'src/App.tsx': '<div/>'
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['webapp-testing']).toBe(false);
  });

  it('does not mark frontend-design for non-web projects', () => {
    const dir = makeProject('cli-proj', {
      'package.json': JSON.stringify({
        name: 'test',
        dependencies: { commander: '^9.0.0' }
      }),
      'src/cli.js': 'console.log("hello");'
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['frontend-design']).toBe(false);
  });

  it('finds package.json in immediate subdirectory', () => {
    const dir = makeProject('monorepo', {
      'web/package.json': JSON.stringify({
        name: 'web',
        dependencies: { react: '^18.0.0', '@supabase/supabase-js': '^2.0.0' },
        scripts: { dev: 'next dev' }
      })
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['dep-update']).toBe(true);
    expect(result.skills['supabase-audit']).toBe(true);
  });

  it('detects auth dependencies', () => {
    const dir = makeProject('auth-proj', {
      'package.json': JSON.stringify({
        name: 'test',
        dependencies: { 'better-auth': '^1.0.0' }
      })
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['security-review']).toBe(true);
    expect(result.skills['trailofbits-security']).toBe(true);
  });

  it('detects Anthropic SDK project', () => {
    const dir = makeProject('claude-proj', {
      'package.json': JSON.stringify({
        name: 'test',
        dependencies: { '@anthropic-ai/sdk': '^0.30.0' }
      })
    });
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['ccusage']).toBe(true);
  });

  it('handles empty project gracefully', () => {
    const dir = makeProject('bare', {});
    const result = heuristicAnalyze(dir, null);
    expect(result.skills['dep-update']).toBe(false);
    expect(result.skills['supabase-audit']).toBe(false);
    expect(result.skills['fix-types']).toBe(false);
    expect(result.skills['ui-polish']).toBe(false);
  });
});
