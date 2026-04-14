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
 */
function cwdToProjectDir(cwd) {
  return cwd.replace(/:\\/g, '--').replace(/[\\/]/g, '-').replace(/_/g, '-');
}

/**
 * Find the most recent JSONL session file for a cwd.
 */
function findSessionFile(cwd) {
  const dirName = cwdToProjectDir(cwd);
  const projectDir = path.join(CLAUDE_DIR, dirName);

  if (!fs.existsSync(projectDir)) return null;

  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        path: path.join(projectDir, f),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime);

    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

/**
 * Read last N lines from a file (tail).
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
 * Parse JSONL lines into structured entries.
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
