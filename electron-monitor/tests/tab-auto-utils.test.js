import { describe, it, expect } from 'vitest';

const { stackColor, scoreColor, groupByStack, matchesSearch, STACK_COLORS, STACK_ORDER } = require('../renderer/tab-auto-utils.js');

describe('stackColor', () => {
  it('returns the mapped color for a known stack', () => {
    expect(stackColor('node')).toBe('#9ece6a');
    expect(stackColor('python')).toBe('#e0af68');
    expect(stackColor('tauri+rust')).toBe('#ff9e64');
    expect(stackColor('electron')).toBe('#7aa2f7');
    expect(stackColor('unknown')).toBe('#565f89');
  });

  it('returns the fallback color for unknown stacks', () => {
    expect(stackColor('haskell')).toBe('#565f89');
    expect(stackColor('')).toBe('#565f89');
    expect(stackColor(undefined)).toBe('#565f89');
    expect(stackColor(null)).toBe('#565f89');
  });

  it('STACK_COLORS is consistent with stackColor', () => {
    for (const [stack, expected] of Object.entries(STACK_COLORS)) {
      expect(stackColor(stack)).toBe(expected);
    }
  });
});

describe('scoreColor', () => {
  it('green for scores >=7', () => {
    expect(scoreColor(7)).toBe('#9ece6a');
    expect(scoreColor(8.5)).toBe('#9ece6a');
    expect(scoreColor(10)).toBe('#9ece6a');
  });

  it('amber for scores 4..6.999', () => {
    expect(scoreColor(4)).toBe('#e0af68');
    expect(scoreColor(5)).toBe('#e0af68');
    expect(scoreColor(6.9)).toBe('#e0af68');
  });

  it('red for scores below 4', () => {
    expect(scoreColor(0)).toBe('#f7768e');
    expect(scoreColor(3.9)).toBe('#f7768e');
  });

  it('treats non-numbers as 0 (red)', () => {
    expect(scoreColor(null)).toBe('#f7768e');
    expect(scoreColor(undefined)).toBe('#f7768e');
    expect(scoreColor('seven')).toBe('#f7768e');
    expect(scoreColor(NaN)).toBe('#f7768e'); // typeof NaN === 'number', but NaN < 4
  });
});

describe('groupByStack', () => {
  it('groups projects by stack and sorts each group by name', () => {
    const projects = [
      ['zeta', { stack: 'node' }],
      ['alpha', { stack: 'node' }],
      ['mid', { stack: 'python' }],
    ];
    const result = groupByStack(projects);
    const node = result.find(g => g.stack === 'node');
    const python = result.find(g => g.stack === 'python');
    expect(node.projects.map(p => p[0])).toEqual(['alpha', 'zeta']);
    expect(python.projects.map(p => p[0])).toEqual(['mid']);
  });

  it('respects the declared STACK_ORDER', () => {
    const projects = [
      ['a', { stack: 'unknown' }],
      ['b', { stack: 'node' }],
      ['c', { stack: 'rust' }],
    ];
    const stacks = groupByStack(projects).map(g => g.stack);
    // node comes before rust, which comes before unknown in STACK_ORDER
    expect(stacks.indexOf('node')).toBeLessThan(stacks.indexOf('rust'));
    expect(stacks.indexOf('rust')).toBeLessThan(stacks.indexOf('unknown'));
  });

  it('drops ordered stacks that have no projects', () => {
    const projects = [['a', { stack: 'node' }]];
    const stacks = groupByStack(projects).map(g => g.stack);
    expect(stacks).toEqual(['node']);
  });

  it('falls back to "unknown" when a project has no stack', () => {
    const result = groupByStack([['a', {}]]);
    expect(result).toEqual([{ stack: 'unknown', projects: [['a', {}]] }]);
  });

  it('returns empty array for empty input', () => {
    expect(groupByStack([])).toEqual([]);
  });

  it('includes unknown/custom stacks not in STACK_ORDER at the end', () => {
    const projects = [
      ['a', { stack: 'node' }],
      ['b', { stack: 'haskell' }],
    ];
    const stacks = groupByStack(projects).map(g => g.stack);
    expect(stacks).toEqual(['node', 'haskell']);
  });

  it('STACK_ORDER is non-empty', () => {
    expect(STACK_ORDER.length).toBeGreaterThan(0);
  });
});

describe('matchesSearch', () => {
  it('empty query matches anything', () => {
    expect(matchesSearch('foo', { stack: 'node' }, '')).toBe(true);
    expect(matchesSearch('', {}, '')).toBe(true);
  });

  it('matches substring of project name, case-insensitively', () => {
    expect(matchesSearch('ClaudioControl', {}, 'claudio')).toBe(true);
    expect(matchesSearch('claudioControl', {}, 'CONTROL')).toBe(true);
  });

  it('matches substring of stack, case-insensitively', () => {
    expect(matchesSearch('foo', { stack: 'Python+Node' }, 'python')).toBe(true);
    expect(matchesSearch('foo', { stack: 'tauri+rust' }, 'RUST')).toBe(true);
  });

  it('returns false when query matches neither name nor stack', () => {
    expect(matchesSearch('foo', { stack: 'node' }, 'python')).toBe(false);
    expect(matchesSearch('bar', { stack: 'rust' }, 'qux')).toBe(false);
  });

  it('handles projects without stack', () => {
    expect(matchesSearch('foo', {}, 'foo')).toBe(true);
    expect(matchesSearch('foo', {}, 'node')).toBe(false);
  });
});
