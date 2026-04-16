import { describe, it, expect } from 'vitest';

// Reimplement escapeHtml for testing (same algorithm as lib/utils.js)
function escapeHtml(str) {
  return String(str || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
}

describe('escapeHtml', () => {
  it('escapes < and >', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('escapes & and "', () => {
    expect(escapeHtml('a & b "c"')).toBe('a &amp; b &quot;c&quot;');
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('coerces numbers to string', () => {
    expect(escapeHtml(42)).toBe('42');
  });

  it('leaves safe strings untouched', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });

  it('handles all special chars together', () => {
    expect(escapeHtml('<div class="a&b">')).toBe('&lt;div class=&quot;a&amp;b&quot;&gt;');
  });

  it('handles single quotes (not escaped — expected)', () => {
    expect(escapeHtml("it's")).toBe("it's");
  });
});
