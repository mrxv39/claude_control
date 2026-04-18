// lib/scheduler-priority.js — Logica pura de priorizacion y seleccion de skills.
// Funciones extraidas del scheduler para poder testearlas directamente sin
// arrancar el loop ni mockear store/executor cuando no hace falta.

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Priority order for auto-enqueue.
// Community skills (webapp-testing, frontend-design, trailofbits-security, pdf, ccusage)
// are filtered by applicableSkills analysis — safe to include here.
const SCORE_SKILLS = [
  { maxScore: 3, skills: ['security-review', 'supabase-audit', 'audit-claude-md', 'trailofbits-security'] },
  { maxScore: 5, skills: ['audit-claude-md', 'dep-update', 'perf-audit', 'add-tests'] },
  { maxScore: 7, skills: ['add-tests', 'ui-polish', 'perf-audit', 'fix-types', 'webapp-testing', 'frontend-design'] },
  { maxScore: 10, skills: ['git-cleanup', 'simplify', 'fix-types', 'pdf', 'ccusage'] },
];

/**
 * Check if a skill was recently executed (within 7 days) for a project.
 * @param {string} project - Project name
 * @param {string} skill - Skill name
 * @param {Array<{project:string, skill:string, timestamp:string}>} logEntries
 * @returns {boolean}
 */
function wasRecentlyRun(project, skill, logEntries) {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  return logEntries.some(
    l => l.project === project && l.skill === skill &&
         l.timestamp && new Date(l.timestamp).getTime() > cutoff
  );
}

/**
 * Hora local en la timezone configurada.
 * @param {{timezone?: string, workHours: {start:number, end:number}}} config
 * @returns {boolean}
 */
function isOutsideWorkHours(config) {
  const tz = config.timezone || 'Europe/Madrid';
  let hour;
  try {
    const localStr = new Date().toLocaleString('en-US', { timeZone: tz, hour12: false, hour: '2-digit' });
    hour = parseInt(localStr, 10);
  } catch {
    hour = new Date().getHours(); // fallback to system timezone
  }
  const { start, end } = config.workHours;
  if (start < end) {
    return hour < start || hour >= end;
  } else {
    return hour >= end && hour < start;
  }
}

/**
 * Get priority level for a project based on last commit age.
 * Manual overrides take precedence. Blacklist always wins.
 * @param {string} name
 * @param {Object} proj - Project data with checks.lastCommitDays
 * @param {Object} config
 * @returns {'high'|'medium'|'low'|'ignored'}
 */
function getProjectPriority(name, proj, config) {
  const blacklist = config.blacklist || [];
  if (blacklist.includes(name)) return 'ignored';

  const overrides = config.priorityOverrides || {};
  if (overrides[name]) return overrides[name];

  const days = proj.checks && proj.checks.lastCommitDays;
  if (days === null || days === undefined) return 'ignored';

  const rules = config.priorityRules || { high: 7, medium: 30, low: 90 };
  if (days <= rules.high) return 'high';
  if (days <= rules.medium) return 'medium';
  if (days <= (rules.low || 90)) return 'low';
  return 'ignored';
}

/**
 * Build ordered skill list per project: primary skills (matching score) first, then rest.
 * Filters out inapplicable skills if applicableSkills analysis exists.
 * @param {Object} proj - Project data with score and optional applicableSkills
 * @returns {string[]} Ordered skill names
 */
function getSkillsForProject(proj) {
  const score = proj.score || 5;
  let primaryRule = null;
  for (const rule of SCORE_SKILLS) {
    if (score <= rule.maxScore) { primaryRule = rule; break; }
  }
  if (!primaryRule) primaryRule = SCORE_SKILLS[SCORE_SKILLS.length - 1];
  const primary = [...primaryRule.skills];
  const seen = new Set(primary);
  const secondary = [];
  for (const rule of SCORE_SKILLS) {
    if (rule === primaryRule) continue;
    for (const s of rule.skills) {
      if (!seen.has(s)) { secondary.push(s); seen.add(s); }
    }
  }
  let allSkills = [...primary, ...secondary];
  const applicable = proj.applicableSkills && proj.applicableSkills.skills;
  if (applicable) {
    allSkills = allSkills.filter(s => applicable[s] !== false);
  }
  return allSkills;
}

module.exports = {
  SEVEN_DAYS_MS,
  SCORE_SKILLS,
  wasRecentlyRun,
  isOutsideWorkHours,
  getProjectPriority,
  getSkillsForProject,
};
