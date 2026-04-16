import { describe, it, expect } from 'vitest';

// Reimplement pure functions from conversation-reader.js for testing

function cwdToProjectDir(cwd) {
  return cwd.replace(/:\\/g, '--').replace(/[\\/]/g, '-').replace(/_/g, '-');
}

function extractText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join(' ');
  }
  if (typeof message.content === 'string') return message.content;
  return '';
}

function extractToolCalls(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content
    .filter(c => c.type === 'tool_use')
    .map(c => {
      const name = c.name || 'unknown';
      let summary = name;
      if (c.input) {
        if (name === 'Edit' && c.input.file_path) {
          summary = `Edit ${c.input.file_path.split(/[\\/]/).pop()}`;
        } else if (name === 'Write' && c.input.file_path) {
          summary = `Write ${c.input.file_path.split(/[\\/]/).pop()}`;
        } else if (name === 'Read' && c.input.file_path) {
          summary = `Read ${c.input.file_path.split(/[\\/]/).pop()}`;
        } else if (name === 'Bash' && c.input.command) {
          summary = `Bash: ${c.input.command.slice(0, 60)}`;
        } else if (name === 'Grep' && c.input.pattern) {
          summary = `Grep: ${c.input.pattern}`;
        } else if (name === 'Glob' && c.input.pattern) {
          summary = `Glob: ${c.input.pattern}`;
        }
      }
      return { name, summary };
    });
}

function parseEntries(text, maxEntries = 50) {
  const lines = text.split('\n').filter(Boolean);
  const entries = [];
  const subset = lines.slice(-maxEntries);

  for (const line of subset) {
    try {
      const obj = JSON.parse(line);
      const entry = { type: obj.type || 'unknown', timestamp: obj.timestamp };

      if (obj.type === 'user') {
        const t = extractText(obj.message);
        entry.summary = t ? t.slice(0, 200) : '[user input]';
      } else if (obj.type === 'assistant') {
        const tools = extractToolCalls(obj.message);
        if (tools.length > 0) {
          entry.summary = tools.map(t => t.summary).join(', ');
          entry.tools = tools;
        } else {
          const t = extractText(obj.message);
          entry.summary = t ? t.slice(0, 200) : '[assistant response]';
        }
      } else if (obj.type === 'tool_result') {
        entry.summary = '[tool result]';
        entry.type = 'tool';
      }

      entries.push(entry);
    } catch {
      // skip malformed
    }
  }
  return entries;
}

describe('cwdToProjectDir', () => {
  it('converts standard Windows path', () => {
    expect(cwdToProjectDir('C:\\Users\\foo\\bar')).toBe('C--Users-foo-bar');
  });

  it('converts path with underscores', () => {
    expect(cwdToProjectDir('C:\\Users\\foo\\bar_baz')).toBe('C--Users-foo-bar-baz');
  });

  it('converts forward slashes', () => {
    expect(cwdToProjectDir('C:\\Users/foo/bar')).toBe('C--Users-foo-bar');
  });

  it('handles drive letter correctly', () => {
    expect(cwdToProjectDir('D:\\Projects\\my_app')).toBe('D--Projects-my-app');
  });

  it('handles deep nested paths', () => {
    expect(cwdToProjectDir('C:\\Users\\user\\Documents\\Claude\\Projects\\claudio_control'))
      .toBe('C--Users-user-Documents-Claude-Projects-claudio-control');
  });
});

describe('extractText', () => {
  it('returns empty string for null', () => {
    expect(extractText(null)).toBe('');
  });

  it('handles string message', () => {
    expect(extractText('hello world')).toBe('hello world');
  });

  it('extracts from content array', () => {
    const msg = { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] };
    expect(extractText(msg)).toBe('hello world');
  });

  it('filters non-text content blocks', () => {
    const msg = { content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'result' }] };
    expect(extractText(msg)).toBe('result');
  });

  it('handles string content field', () => {
    expect(extractText({ content: 'plain text' })).toBe('plain text');
  });
});

describe('extractToolCalls', () => {
  it('returns empty for null message', () => {
    expect(extractToolCalls(null)).toEqual([]);
  });

  it('extracts Edit tool with file basename', () => {
    const msg = { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\foo\\bar.js' } }] };
    const result = extractToolCalls(msg);
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('Edit bar.js');
  });

  it('extracts Bash with truncated command', () => {
    const cmd = 'a'.repeat(100);
    const msg = { content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] };
    const result = extractToolCalls(msg);
    expect(result[0].summary).toBe('Bash: ' + 'a'.repeat(60));
  });

  it('extracts Grep with pattern', () => {
    const msg = { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }] };
    expect(extractToolCalls(msg)[0].summary).toBe('Grep: TODO');
  });

  it('uses tool name as fallback for unknown tools', () => {
    const msg = { content: [{ type: 'tool_use', name: 'CustomTool', input: {} }] };
    expect(extractToolCalls(msg)[0].summary).toBe('CustomTool');
  });
});

describe('parseEntries', () => {
  it('parses user message', () => {
    const line = JSON.stringify({ type: 'user', message: 'fix the bug', timestamp: '2026-04-16T10:00:00Z' });
    const entries = parseEntries(line);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('user');
    expect(entries[0].summary).toBe('fix the bug');
  });

  it('parses assistant with tool calls', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/foo/bar.js' } }] }
    });
    const entries = parseEntries(line);
    expect(entries[0].summary).toBe('Read bar.js');
    expect(entries[0].tools).toHaveLength(1);
  });

  it('parses tool_result as type tool', () => {
    const line = JSON.stringify({ type: 'tool_result' });
    const entries = parseEntries(line);
    expect(entries[0].type).toBe('tool');
    expect(entries[0].summary).toBe('[tool result]');
  });

  it('skips malformed lines', () => {
    const text = 'NOT_JSON\n' + JSON.stringify({ type: 'user', message: 'hi' });
    const entries = parseEntries(text);
    expect(entries).toHaveLength(1);
  });

  it('limits to maxEntries (last N)', () => {
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ type: 'user', message: `msg${i}` }));
    const entries = parseEntries(lines.join('\n'), 3);
    expect(entries).toHaveLength(3);
    expect(entries[0].summary).toBe('msg7');
  });
});
