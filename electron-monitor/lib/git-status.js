/**
 * git-status.js — Quick git info for session projects.
 *
 * Returns { branch, dirty, recentCommits } per cwd.
 * Used to show git badges on session chips.
 */

const { gitExec, gitExecLines } = require('./git-exec');

/**
 * Get the current git branch name.
 * @param {string} cwd - Project directory
 * @returns {Promise<string|null>} Branch name or null on error
 */
function gitBranch(cwd) {
  return gitExec(cwd, ['branch', '--show-current']);
}

/**
 * Count uncommitted changes in the working tree.
 * @param {string} cwd - Project directory
 * @returns {Promise<number>} Number of changed files
 */
async function gitDirtyCount(cwd) {
  const lines = await gitExecLines(cwd, ['status', '--porcelain']);
  return lines.length;
}

/**
 * Get recent commit messages (one-line format).
 * @param {string} cwd - Project directory
 * @param {number} [count=3] - Number of commits to return
 * @returns {Promise<string[]>} Array of one-line commit strings
 */
function gitRecentCommits(cwd, count = 3) {
  return gitExecLines(cwd, ['log', '--oneline', `-${count}`]);
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
