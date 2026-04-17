/**
 * conversation-reader.js — Reads Claude Code session JSONL for log display.
 *
 * Reads the last N entries from a session's conversation JSONL file,
 * extracts tool calls, file operations, and summaries.
 */

const fs = require('fs');
const path = require('path');

const CLAUDE_DIR = path.join(process.env.USERPROFILE, '.claude', 'projects');

/**
 * Convert a cwd to Claude's project directory name.
 * Same logic as get-sessions.ps1: `:\` → `--`, `\` and `/` → `-`, `_` → `-`
 * @param {string} cwd - Absolute project path
 * @returns {string} Dash-separated directory name
 */
function cwdToProjectDir(cwd) {
  return cwd.replace(/:\\/g, '--').replace(/[\\/]/g, '-').replace(/_/g, '-');
}

/** @type {Map<string, {path: string|null, at: number}>} cwd -> cached session file */
const _sessionFileCache = new Map();
const SESSION_FILE_CACHE_TTL = 10 * 1000; // 10s

/**
 * Find the most recent JSONL session file for a cwd.
 * Cached for 10s per cwd to avoid repeated statSync on all JSONL files.
 * @param {string} cwd - Project directory
 * @returns {string|null} Absolute path to most recent JSONL file
 */
function findSessionFile(cwd) {
  const now = Date.now();
  const cached = _sessionFileCache.get(cwd);
  if (cached && (now - cached.at) < SESSION_FILE_CACHE_TTL) return cached.path;

  const dirName = cwdToProjectDir(cwd);
  const projectDir = path.join(CLAUDE_DIR, dirName);

  if (!fs.existsSync(projectDir)) {
    _sessionFileCache.set(cwd, { path: null, at: now });
    return null;
  }

  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = path.join(projectDir, f);
        try { return { path: full, mtime: fs.statSync(full).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    const result = files.length > 0 ? files[0].path : null;
    _sessionFileCache.set(cwd, { path: result, at: now });
    return result;
  } catch {
    _sessionFileCache.set(cwd, { path: null, at: now });
    return null;
  }
}

/**
 * Read the tail of a file (last maxBytes).
 * @param {string} filePath - Absolute file path
 * @param {number} [maxBytes=65536] - Maximum bytes to read from end
 * @returns {string} UTF-8 text from the tail of the file
 */
function tailFile(filePath, maxBytes = 64 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const readSize = Math.min(size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * @typedef {Object} ConversationEntry
 * @property {string} type - 'user' | 'assistant' | 'tool' | 'unknown'
 * @property {string} [summary] - Human-readable summary of the entry
 * @property {string} [timestamp] - ISO timestamp
 * @property {Array<{name: string, summary: string}>} [tools] - Tool calls (assistant entries only)
 */

/**
 * Parse JSONL lines into structured entries.
 * @param {string} text - Raw JSONL text
 * @param {number} [maxEntries=50] - Max entries to parse from the tail
 * @returns {ConversationEntry[]}
 */
function parseEntries(text, maxEntries = 50) {
  const lines = text.split('\n').filter(Boolean);
  const entries = [];

  // Take last maxEntries lines
  const subset = lines.slice(-maxEntries);

  for (const line of subset) {
    try {
      const obj = JSON.parse(line);
      const entry = { type: obj.type || 'unknown', timestamp: obj.timestamp };

      if (obj.type === 'user') {
        // User message
        const text = extractText(obj.message);
        entry.summary = text ? text.slice(0, 200) : '[user input]';
      } else if (obj.type === 'assistant') {
        // Assistant response — extract tool calls
        const tools = extractToolCalls(obj.message);
        if (tools.length > 0) {
          entry.summary = tools.map(t => t.summary).join(', ');
          entry.tools = tools;
        } else {
          const text = extractText(obj.message);
          entry.summary = text ? text.slice(0, 200) : '[assistant response]';
        }
      } else if (obj.type === 'tool_result') {
        entry.summary = '[tool result]';
        entry.type = 'tool';
      }

      entries.push(entry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

/**
 * Extract plain text from a Claude message object.
 * @param {Object|string|null} message - Raw message (string, content array, or null)
 * @returns {string}
 */
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

/**
 * Extract tool_use blocks from an assistant message.
 * @param {Object|null} message - Raw assistant message
 * @returns {Array<{name: string, summary: string}>}
 */
function extractToolCalls(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content
    .filter(c => c.type === 'tool_use')
    .map(c => {
      const name = c.name || 'unknown';
      let summary = name;

      // Add useful context based on tool type
      if (c.input) {
        if (name === 'Edit' && c.input.file_path) {
          summary = `Edit ${path.basename(c.input.file_path)}`;
        } else if (name === 'Write' && c.input.file_path) {
          summary = `Write ${path.basename(c.input.file_path)}`;
        } else if (name === 'Read' && c.input.file_path) {
          summary = `Read ${path.basename(c.input.file_path)}`;
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

/**
 * Get conversation summary for a session.
 * @param {string} cwd - Project directory
 * @returns {Array<{type, summary, timestamp, tools?}>}
 */
function getConversationLog(cwd) {
  const sessionFile = findSessionFile(cwd);
  if (!sessionFile) return [];

  const text = tailFile(sessionFile);
  return parseEntries(text);
}

module.exports = { getConversationLog, findSessionFile };
