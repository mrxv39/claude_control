/**
 * skill-analyzer.js — Determines which skills apply to each project.
 *
 * Two modes:
 *   1. Heuristic (free, instant) — checks file existence and imports
 *   2. Claude (sonnet, ~$0.02/project) — structured JSON prompt, fallback to heuristic
 *
 * Results cached in orchestrator.json under project.applicableSkills.
 */

/**
 * @typedef {Object} SkillAnalysis
 * @property {Object<string, boolean>} skills - Skill name -> applicable
 * @property {string} analyzedAt - ISO timestamp
 * @property {'heuristic'|'claude'} method
 * @property {string} [topSkill] - Most impactful skill (claude method only)
 * @property {string} [topSkillReason] - Why this skill matters most
 */

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

/** @type {string[]} */
const ALL_SKILLS = [
  'audit-claude-md', 'security-review', 'dep-update', 'simplify', 'add-tests',
  'git-cleanup', 'supabase-audit', 'perf-audit', 'fix-types', 'ui-polish',
  'webapp-testing', 'frontend-design', 'trailofbits-security', 'pdf', 'ccusage'
];

// --- Helpers ---

/**
 * @param {string} base
 * @param {...string} segments
 * @returns {boolean}
 */
function exists(base, ...segments) {
  return fs.existsSync(path.join(base, ...segments));
}

/**
 * Quick recursive search for file extensions (max 2 levels deep).
 * @param {string} base - Directory to search
 * @param {string[]} patterns - File extensions to match (e.g. ['.ts', '.tsx'])
 * @returns {boolean}
 */
function globAny(base, patterns) {
  // Quick recursive search for file extensions (max 2 levels deep for speed)
  try {
    const check = (dir, depth) => {
      if (depth > 2) return false;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'build') continue;
        const full = path.join(dir, e.name);
        if (e.isFile() && patterns.some(p => e.name.endsWith(p))) return true;
        if (e.isDirectory() && depth < 2 && check(full, depth + 1)) return true;
      }
      return false;
    };
    return check(base, 0);
  } catch { return false; }
}

/**
 * @param {string} filePath
 * @param {RegExp} pattern
 * @returns {boolean}
 */
function grepFile(filePath, pattern) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return pattern.test(content);
  } catch { return false; }
}

/**
 * Search for a regex pattern in files with given extensions.
 * @param {string} base - Directory to search
 * @param {string[]} extensions - File extensions to check
 * @param {RegExp} pattern - Pattern to search for
 * @param {number} [maxDepth=2] - Max directory depth
 * @returns {boolean}
 */
function grepAny(base, extensions, pattern, maxDepth = 2) {
  // Search for a regex pattern in files with given extensions
  try {
    const check = (dir, depth) => {
      if (depth > maxDepth) return false;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'build') continue;
        const full = path.join(dir, e.name);
        if (e.isFile() && extensions.some(ext => e.name.endsWith(ext))) {
          if (grepFile(full, pattern)) return true;
        }
        if (e.isDirectory() && depth < maxDepth && check(full, depth + 1)) return true;
      }
      return false;
    };
    return check(base, 0);
  } catch { return false; }
}

/**
 * @param {string} base
 * @returns {Object|null} Parsed package.json or null
 */
function readPackageJson(base) {
  try {
    return JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  } catch { return null; }
}

// --- Heuristic Analysis ---

/**
 * Analyze skill applicability using file existence and dependency checks.
 * @param {string} projectPath - Absolute path to project root
 * @param {string} [stack] - Stack identifier (unused, kept for API compat)
 * @returns {SkillAnalysis}
 */
function heuristicAnalyze(projectPath, stack) {
  // Try root package.json first, then one level deep (monorepos, subcarpetas)
  let pkg = readPackageJson(projectPath);
  if (!pkg) {
    try {
      const entries = fs.readdirSync(projectPath, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') {
          pkg = readPackageJson(path.join(projectPath, e.name));
          if (pkg) break;
        }
      }
    } catch {}
  }
  const allDeps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
  const manifests = ['package.json', 'Cargo.toml', 'pyproject.toml', 'requirements.txt'];
  const hasManifest = manifests.some(m => exists(projectPath, m)) || !!pkg;

  const hasTs = globAny(projectPath, ['.ts', '.tsx']);
  const hasUi = globAny(projectPath, ['.jsx', '.tsx', '.vue', '.svelte']);
  const hasHtml = globAny(projectPath, ['.html', '.css']);
  const hasPy = globAny(projectPath, ['.py']);

  const hasSupabase = exists(projectPath, 'supabase') ||
    (pkg && (allDeps['@supabase/supabase-js'] || allDeps['@supabase/ssr']));

  const hasDevScript = pkg && pkg.scripts && (pkg.scripts.dev || pkg.scripts.start);
  const hasWebFramework = pkg && (
    allDeps['next'] || allDeps['react'] || allDeps['vue'] || allDeps['svelte'] ||
    allDeps['@sveltejs/kit'] || allDeps['nuxt'] || allDeps['astro'] || allDeps['vite']
  );

  const hasPdf = globAny(projectPath, ['.pdf']) ||
    (pkg && (allDeps['pdf-lib'] || allDeps['pdfkit'] || allDeps['jspdf'] || allDeps['puppeteer']));

  const hasAnthropicSdk = pkg && (allDeps['@anthropic-ai/sdk'] || allDeps['anthropic']);

  const hasCrypto = pkg && (allDeps['bcrypt'] || allDeps['bcryptjs'] || allDeps['jsonwebtoken'] ||
    allDeps['jose'] || allDeps['crypto-js'] || allDeps['argon2']);
  const hasFinancial = pkg && (allDeps['stripe'] || allDeps['@stripe/stripe-js'] ||
    allDeps['paypal-rest-sdk'] || allDeps['braintree']);
  const hasAuth = pkg && (allDeps['passport'] || allDeps['next-auth'] || allDeps['@auth/core'] ||
    allDeps['lucia'] || allDeps['better-auth']);

  const skills = {
    'audit-claude-md': true,  // always useful
    'git-cleanup': true,      // always useful
    'dep-update': hasManifest,
    'security-review': !!(hasSupabase || hasCrypto || hasAuth || hasFinancial || hasPy),
    'supabase-audit': !!hasSupabase,
    'fix-types': !!(hasTs || hasPy),
    'ui-polish': !!(hasUi || hasHtml),
    'frontend-design': !!(hasWebFramework && hasUi),
    'webapp-testing': !!(hasDevScript && hasWebFramework),
    'add-tests': hasManifest,  // any project with code can have tests
    'simplify': hasManifest,   // any project with code
    'perf-audit': !!(hasWebFramework || hasSupabase),
    'pdf': !!hasPdf,
    'trailofbits-security': !!(hasCrypto || hasFinancial || hasAuth),
    'ccusage': !!hasAnthropicSdk
  };

  return {
    skills,
    analyzedAt: new Date().toISOString(),
    method: 'heuristic'
  };
}

// --- Claude Analysis ---

const ANALYSIS_PROMPT = `Analyze this project and return ONLY a JSON object. No markdown, no explanation, no code fences.

For each skill, set true if this project would genuinely benefit from it, false otherwise:

- "audit-claude-md": project needs CLAUDE.md created or improved
- "security-review": has backend, APIs, auth, or handles user data
- "dep-update": has package.json, Cargo.toml, pyproject.toml, or requirements.txt
- "simplify": has >5 source files with business logic worth reviewing
- "add-tests": has code but missing or minimal test coverage
- "git-cleanup": has merged branches or incomplete .gitignore
- "supabase-audit": uses @supabase/supabase-js or has supabase/ directory
- "perf-audit": has frontend with components or backend with database queries
- "fix-types": has TypeScript files or Python that could benefit from type hints
- "ui-polish": has UI files (JSX/TSX/Vue/Svelte/HTML with interactive elements)
- "webapp-testing": has a web app with dev server that could be E2E tested
- "frontend-design": has user-facing web UI that could look better
- "pdf": generates, processes, or manipulates PDF files
- "trailofbits-security": has crypto, authentication, or financial transaction code
- "ccusage": uses Claude API or Anthropic SDK

Also pick the ONE skill that would have the most impact right now for this project and explain why in one short sentence.

Return: {"skills":{"audit-claude-md":true,"security-review":false,...},"topSkill":"skill-name","topSkillReason":"why this skill matters most"}`;

/**
 * Analyze skill applicability using Claude (sonnet) for richer results.
 * @param {string} projectPath - Absolute path to project root
 * @returns {Promise<SkillAnalysis|null>} null on timeout or parse failure
 */
function claudeAnalyze(projectPath) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve(null); // fallback to heuristic
    }, 60000); // 1 min max

    const proc = spawn('claude', [
      '--print', '-p', ANALYSIS_PROMPT,
      '--model', 'sonnet',
      '--max-turns', '1',
      '--output-format', 'text',
      '--dangerously-skip-permissions'
    ], {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });
    proc.stdin.end();

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', () => {}); // ignore

    proc.on('close', () => {
      clearTimeout(timeout);
      // Extract JSON from output
      const match = output.match(/\{[\s\S]*"skills"[\s\S]*\}/);
      if (!match) return resolve(null);
      try {
        const parsed = JSON.parse(match[0]);
        if (!parsed.skills || typeof parsed.skills !== 'object') return resolve(null);
        // Validate: all values must be boolean
        for (const [k, v] of Object.entries(parsed.skills)) {
          if (typeof v !== 'boolean') parsed.skills[k] = !!v;
        }
        // Ensure all skills are present (fill missing with true to be safe)
        for (const s of ALL_SKILLS) {
          if (!(s in parsed.skills)) parsed.skills[s] = true;
        }
        const result = {
          skills: parsed.skills,
          analyzedAt: new Date().toISOString(),
          method: 'claude'
        };
        if (parsed.topSkill && ALL_SKILLS.includes(parsed.topSkill)) {
          result.topSkill = parsed.topSkill;
          if (parsed.topSkillReason) result.topSkillReason = parsed.topSkillReason;
        }
        resolve(result);
      } catch {
        resolve(null);
      }
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

// --- Public API ---

/**
 * Analyze which skills apply to a project.
 * Tries Claude first (if useClaude=true), falls back to heuristic.
 * @param {{name: string, path: string, stack: string}} project
 * @param {{useClaude?: boolean}} [options]
 * @returns {Promise<SkillAnalysis>}
 */
async function analyzeSkills(project, { useClaude = false } = {}) {
  if (useClaude) {
    const result = await claudeAnalyze(project.path);
    if (result) return result;
  }
  return heuristicAnalyze(project.path, project.stack);
}

module.exports = { analyzeSkills, heuristicAnalyze, ALL_SKILLS };
