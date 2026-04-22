import { describe, it, expect } from 'vitest';

const { esc, rateColor, COLORS } = require('../renderer/common.js');

describe('esc', () => {
  it('escapes < and >', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
    expect(esc('a < b > c')).toBe('a &lt; b &gt; c');
  });

  it('escapes & to &amp;', () => {
    expect(esc('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('escapes double quotes to &quot;', () => {
    expect(esc('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('escapes all special chars together', () => {
    expect(esc('<a href="x">A & B</a>'))
      .toBe('&lt;a href=&quot;x&quot;&gt;A &amp; B&lt;/a&gt;');
  });

  it('does not escape single quotes (documented behavior)', () => {
    expect(esc("it's fine")).toBe("it's fine");
  });

  it('passes through strings without special chars', () => {
    expect(esc('hello world')).toBe('hello world');
    expect(esc('')).toBe('');
  });

  it('converts null and undefined to empty string', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('converts falsy values (0, false) to empty string', () => {
    expect(esc(0)).toBe('');
    expect(esc(false)).toBe('');
  });

  it('stringifies numbers and other truthy non-strings', () => {
    expect(esc(42)).toBe('42');
    expect(esc(-1)).toBe('-1');
  });

  it('handles repeated occurrences', () => {
    expect(esc('<<<>>>')).toBe('&lt;&lt;&lt;&gt;&gt;&gt;');
    expect(esc('& & &')).toBe('&amp; &amp; &amp;');
  });
});

describe('rateColor', () => {
  it('returns green for pct < 50', () => {
    expect(rateColor(0)).toBe(COLORS.green);
    expect(rateColor(25)).toBe(COLORS.green);
    expect(rateColor(49)).toBe(COLORS.green);
    expect(rateColor(49.99)).toBe(COLORS.green);
  });

  it('returns yellow for 50 <= pct < 80', () => {
    expect(rateColor(50)).toBe(COLORS.yellow);
    expect(rateColor(65)).toBe(COLORS.yellow);
    expect(rateColor(79)).toBe(COLORS.yellow);
    expect(rateColor(79.99)).toBe(COLORS.yellow);
  });

  it('returns red for pct >= 80', () => {
    expect(rateColor(80)).toBe(COLORS.red);
    expect(rateColor(95)).toBe(COLORS.red);
    expect(rateColor(100)).toBe(COLORS.red);
    expect(rateColor(150)).toBe(COLORS.red);
  });

  it('treats negative values as green', () => {
    expect(rateColor(-10)).toBe(COLORS.green);
  });
});

describe('COLORS', () => {
  it('exposes the core palette keys', () => {
    expect(COLORS.green).toBe('#9ece6a');
    expect(COLORS.yellow).toBe('#e0af68');
    expect(COLORS.red).toBe('#f7768e');
    expect(COLORS.blue).toBe('#7aa2f7');
    expect(COLORS.purple).toBe('#bb9af7');
    expect(COLORS.dim).toBe('#565f89');
  });

  it('exposes priority palette for high/medium/low/ignored', () => {
    expect(COLORS.priority.high).toBe('#9ece6a');
    expect(COLORS.priority.medium).toBe('#e0af68');
    expect(COLORS.priority.low).toBe('#7aa2f7');
    expect(COLORS.priority.ignored).toBe('#565f89');
  });

  it('exposes pacing palette for all scheduler modes', () => {
    expect(COLORS.pacing.pace).toBeDefined();
    expect(COLORS.pacing.accelerate).toBeDefined();
    expect(COLORS.pacing.burst).toBeDefined();
    expect(COLORS.pacing.coast).toBeDefined();
    expect(COLORS.pacing.wait).toBeDefined();
  });

  it('all palette values are valid hex colors', () => {
    const hex = /^#[0-9a-f]{6}$/i;
    for (const key of ['green', 'yellow', 'red', 'blue', 'purple', 'dim']) {
      expect(COLORS[key]).toMatch(hex);
    }
    for (const v of Object.values(COLORS.priority)) expect(v).toMatch(hex);
    for (const v of Object.values(COLORS.pacing)) expect(v).toMatch(hex);
  });
});
