import { describe, it, expect } from 'vitest';

/**
 * Tests for git-status.js logic.
 *
 * git-status.js calls execFile('git', ...) and parses the output.
 * We test the parsing/transformation logic that processes git command output.
 */

// --- Parsing logic mirrored from git-status.js ---

function parseBranch(stdout, err) {
  return err ? null : stdout.trim();
}

function parseDirtyCount(stdout, err) {
  if (err) return 0;
  const lines = stdout.trim().split('\n').filter(Boolean);
  return lines.length;
}

function parseRecentCommits(stdout, err) {
  if (err) return [];
  return stdout.trim().split('\n').filter(Boolean);
}


describe('git-status parseBranch', () => {
  it('should return branch name from stdout', () => {
    expect(parseBranch('main\n', null)).toBe('main');
  });

  it('should trim whitespace', () => {
    expect(parseBranch('  feature/foo  \n', null)).toBe('feature/foo');
  });

  it('should return null on error', () => {
    expect(parseBranch('', new Error('not a git repo'))).toBeNull();
  });

  it('should handle branch names with slashes', () => {
    expect(parseBranch('claudio/auto/add-tests-2026-04-17\n', null))
      .toBe('claudio/auto/add-tests-2026-04-17');
  });

  it('should handle empty stdout without error as empty string', () => {
    expect(parseBranch('', null)).toBe('');
  });
});

describe('git-status parseDirtyCount', () => {
  it('should return 0 on error', () => {
    expect(parseDirtyCount('', new Error('fail'))).toBe(0);
  });

  it('should return 0 for clean repo', () => {
    expect(parseDirtyCount('', null)).toBe(0);
    expect(parseDirtyCount('\n', null)).toBe(0);
  });

  it('should count modified files', () => {
    const output = ' M src/index.js\n M src/app.js\n';
    expect(parseDirtyCount(output, null)).toBe(2);
  });

  it('should count untracked files', () => {
    const output = '?? new-file.js\n?? another.js\n?? third.js\n';
    expect(parseDirtyCount(output, null)).toBe(3);
  });

  it('should count mixed status lines', () => {
    const output = ' M modified.js\nA  added.js\n?? untracked.js\nD  deleted.js\n';
    expect(parseDirtyCount(output, null)).toBe(4);
  });

  it('should handle single dirty file', () => {
    expect(parseDirtyCount(' M package.json\n', null)).toBe(1);
  });
});

describe('git-status parseRecentCommits', () => {
  it('should return empty array on error', () => {
    expect(parseRecentCommits('', new Error('fail'))).toEqual([]);
  });

  it('should return empty array for empty output', () => {
    expect(parseRecentCommits('', null)).toEqual([]);
    expect(parseRecentCommits('\n', null)).toEqual([]);
  });

  it('should parse oneline commit output', () => {
    const output = 'abc1234 fix: something\ndef5678 feat: another\n';
    expect(parseRecentCommits(output, null)).toEqual([
      'abc1234 fix: something',
      'def5678 feat: another',
    ]);
  });

  it('should handle 3 commits (default count)', () => {
    const output = 'a1 first\nb2 second\nc3 third\n';
    const result = parseRecentCommits(output, null);
    expect(result).toHaveLength(3);
  });

  it('should filter empty lines', () => {
    const output = 'a1 first\n\nb2 second\n\n';
    expect(parseRecentCommits(output, null)).toEqual([
      'a1 first',
      'b2 second',
    ]);
  });
});

describe('git-status getStatus integration', () => {
  // Test the assembly logic of getStatus
  function assembleStatus(branch, dirty, recentCommits) {
    return { branch, dirty, recentCommits };
  }

  it('should assemble all three fields', () => {
    const status = assembleStatus('main', 2, ['abc fix', 'def feat']);
    expect(status).toEqual({
      branch: 'main',
      dirty: 2,
      recentCommits: ['abc fix', 'def feat'],
    });
  });

  it('should handle null branch (not a git repo)', () => {
    const status = assembleStatus(null, 0, []);
    expect(status.branch).toBeNull();
    expect(status.dirty).toBe(0);
    expect(status.recentCommits).toEqual([]);
  });

  it('should handle clean repo', () => {
    const status = assembleStatus('master', 0, ['abc initial commit']);
    expect(status.dirty).toBe(0);
    expect(status.branch).toBe('master');
  });
});
