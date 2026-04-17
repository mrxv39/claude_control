/**
 * git-status.js — Quick git info for session projects.
 *
 * Returns { branch, dirty, recentCommits } per cwd.
 * Used to show git badges on session chips.
 */

const { execFile } = require('child_process');

/**
 * Get the current git branch name.
 * @param {string} cwd - Project directory
 * @returns {Promise<string|null>} Branch name or null on error
 */
function gitBranch(cwd) {
  return new Promise(resolve => {
    execFile('git', ['branch', '--show-current'], { cwd, timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/**
 * Count uncommitted changes in the working tree.
 * @param {string} cwd - Project directory
 * @returns {Promise<number>} Number of changed files
 */
function gitDirtyCount(cwd) {
  return new Promise(resolve => {
    execFile('git', ['status', '--porcelain'], { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(0);
      const lines = stdout.trim().split('\n').filter(Boolean);
      resolve(lines.length);
    });
  });
}

/**
 * Get recent commit messages (one-line format).
 * @param {string} cwd - Project directory
 * @param {number} [count=3] - Number of commits to return
 * @returns {Promise<string[]>} Array of one-line commit strings
 */
function gitRecentCommits(cwd, count = 3) {
  return new Promise(resolve => {
    execFile('git', ['log', `--oneline`, `-${count}`], { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.trim().split('\n').filter(Boolean));
    });
  });
}

/**
 * Get git status for a project directory.
 * @param {string} cwd
 * @returns {Promise<{branch: string|null, dirty: number, recentCommits: string[]}>}
 */
async function getStatus(cwd) {
  const [branch, dirty, recentCommits] = await Promise.all([
    gitBranch(cwd),
    gitDirtyCount(cwd),
    gitRecentCommits(cwd)
  ]);
  return { branch, dirty, recentCommits };
}

module.exports = { getStatus };
