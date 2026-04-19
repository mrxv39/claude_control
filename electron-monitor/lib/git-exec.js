/**
 * git-exec.js — Thin wrapper around execFile('git', ...) for async/await use.
 *
 * Most call sites ended up writing the same Promise boilerplate around
 * execFile (git-status.js, ipc/autonomous-handlers.js, executor.js), with
 * inconsistent error handling. This module centralizes that pattern.
 */

const { execFile } = require('child_process');

/**
 * Run a git subcommand and resolve with trimmed stdout.
 *
 * On error/timeout/non-zero exit, resolves with `null` (not reject).
 * Callers that need to distinguish errors from empty output should check
 * against null explicitly. This matches the behavior of existing call sites,
 * which all swallow git errors silently.
 *
 * @param {string} cwd
 * @param {string[]} args - git subcommand + flags (no leading "git")
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<string|null>} trimmed stdout, or null on error
 */
function gitExec(cwd, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim());
    });
  });
}

/**
 * Run git and return stdout split into non-empty lines.
 * @param {string} cwd
 * @param {string[]} args
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<string[]>} list of lines (empty array on error)
 */
async function gitExecLines(cwd, args, timeoutMs = 5000) {
  const out = await gitExec(cwd, args, timeoutMs);
  if (!out) return [];
  return out.split('\n').filter(Boolean);
}

module.exports = { gitExec, gitExecLines };
