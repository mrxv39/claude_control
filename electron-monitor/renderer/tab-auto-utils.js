// renderer/tab-auto-utils.js — Pure helpers for tab-auto.js (color maps,
// grouping, search filter). Extracted so they can be unit-tested without
// requiring the DOM or Electron renderer.

const STACK_COLORS = {
  'node': '#9ece6a',
  'python': '#e0af68',
  'tauri+rust': '#ff9e64',
  'electron': '#7aa2f7',
  'python+node': '#bb9af7',
  'rust': '#ff9e64',
  'unknown': '#565f89',
};

const STACK_ORDER = ['node', 'tauri+rust', 'rust', 'python', 'python+node', 'electron', 'unknown'];

function stackColor(stack) { return STACK_COLORS[stack] || '#565f89'; }

function scoreColor(score) {
  const n = typeof score === 'number' ? score : 0;
  if (n >= 7) return '#9ece6a';
  if (n >= 4) return '#e0af68';
  return '#f7768e';
}

/**
 * Group projects by stack, sort alphabetically within each group, then by
 * the declared stack order. Unknown stacks go last in the order they appear.
 * @param {Array<[string, {stack?: string}]>} projects
 * @returns {Array<{stack: string, projects: Array<[string, Object]>}>}
 */
function groupByStack(projects) {
  const groups = {};
  for (const [name, p] of projects) {
    const s = p.stack || 'unknown';
    if (!groups[s]) groups[s] = [];
    groups[s].push([name, p]);
  }
  for (const k of Object.keys(groups)) groups[k].sort((a, b) => a[0].localeCompare(b[0]));
  return STACK_ORDER
    .map(s => ({ stack: s, projects: groups[s] || [] }))
    .filter(g => g.projects.length)
    .concat(Object.keys(groups).filter(k => !STACK_ORDER.includes(k)).map(s => ({ stack: s, projects: groups[s] })));
}

/**
 * Case-insensitive substring match against project name or stack.
 * @param {string} name
 * @param {{stack?: string}} p
 * @param {string} q - Search query ('' matches everything)
 * @returns {boolean}
 */
function matchesSearch(name, p, q) {
  if (!q) return true;
  const lower = q.toLowerCase();
  if (name.toLowerCase().includes(lower)) return true;
  if ((p.stack || '').toLowerCase().includes(lower)) return true;
  return false;
}

module.exports = { stackColor, scoreColor, groupByStack, matchesSearch, STACK_COLORS, STACK_ORDER };
