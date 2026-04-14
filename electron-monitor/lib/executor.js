/**
 * executor.js — Runs a single Claude Code task on a project.
 *
 * Spawns `claude --print` with appropriate flags, captures output,
 * always works in a git branch (claudio/auto/<skill>-<date>).
 * Never touches master. Never pushes.
 */

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const store = require('./orchestrator-store');

const RUNS_DIR = path.join(store.STATE_DIR, 'runs');

// Skill definitions: prompt, model, budget
const SKILLS = {
  'audit-claude-md': {
    model: 'haiku',
    budgetUsd: 0.02,
    prompt: `Analiza este proyecto y su CLAUDE.md (si existe). Si no existe, crea uno con: arquitectura, comandos de build/test/dev, convenciones, archivos clave, y gotchas. Si existe, mejóralo con información que falte. Se conciso y práctico. Solo modifica CLAUDE.md, nada más.`
  },
  'security-review': {
    model: 'sonnet',
    budgetUsd: 0.10,
    prompt: `Haz un review de seguridad de este proyecto. Busca: command injection, XSS, SQL injection, secrets hardcodeados, permisos excesivos, dependencias con vulnerabilidades conocidas. Solo arregla issues CRÍTICOS (no warnings menores). Trabaja en los archivos fuente, no en tests ni configs.`
  },
  'dep-update': {
    model: 'sonnet',
    budgetUsd: 0.15,
    prompt: `Revisa las dependencias de este proyecto. Actualiza las que estén desactualizadas (minor/patch, no major). Si hay tests, ejecútalos después de actualizar para verificar que nada se rompe. Si un test falla, revierte esa actualización específica.`
  },
  'simplify': {
    model: 'sonnet',
    budgetUsd: 0.10,
    prompt: `Revisa el código de este proyecto buscando oportunidades de simplificación: código duplicado, funciones demasiado largas, complejidad innecesaria, imports no usados. Aplica solo simplificaciones seguras que no cambien el comportamiento. No toques tests.`
  },
  'add-tests': {
    model: 'sonnet',
    budgetUsd: 0.20,
    prompt: `Analiza este proyecto e identifica las funciones/módulos más críticos que no tienen tests. Añade tests para los 2-3 paths más importantes. Usa el framework de testing que ya use el proyecto (vitest, jest, pytest, etc). Si no hay framework, sugiere uno pero no lo instales. No modifiques código existente, solo añade tests nuevos.`
  },
  'git-cleanup': {
    model: 'haiku',
    budgetUsd: 0.02,
    prompt: `Limpia este repositorio git: elimina ramas locales ya mergeadas (excepto master/main), verifica que .gitignore cubre node_modules, dist, build, .env, *.log, y otros patrones comunes para el stack del proyecto. Solo modifica .gitignore si le faltan entradas importantes.`
  }
};

function ensureRunsDir() {
  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
}

/**
 * Create a git branch for the autonomous work.
 * Returns true if branch created, false if failed.
 */
function createBranch(cwd, skill) {
  const date = new Date().toISOString().slice(0, 10);
  const branch = `claudio/auto/${skill}-${date}`;
  return new Promise(resolve => {
    execFile('git', ['checkout', '-b', branch], { cwd, timeout: 10000 }, (err) => {
      if (err) {
        // Branch might already exist, try with timestamp
        const branch2 = `claudio/auto/${skill}-${date}-${Date.now() % 10000}`;
        execFile('git', ['checkout', '-b', branch2], { cwd, timeout: 10000 }, (err2) => {
          resolve(err2 ? null : branch2);
        });
      } else {
        resolve(branch);
      }
    });
  });
}

/**
 * Return to the previous branch (master/main).
 */
function returnToMainBranch(cwd) {
  return new Promise(resolve => {
    // Try master first, then main
    execFile('git', ['checkout', 'master'], { cwd, timeout: 10000 }, (err) => {
      if (err) {
        execFile('git', ['checkout', 'main'], { cwd, timeout: 10000 }, () => resolve());
      } else {
        resolve();
      }
    });
  });
}

/**
 * Check if a branch has any commits beyond what it branched from.
 */
function branchHasCommits(cwd, branch) {
  return new Promise(resolve => {
    execFile('git', ['log', 'HEAD...HEAD~1', '--oneline'], { cwd, timeout: 5000 }, (err, stdout) => {
      // Simple heuristic: check if branch differs from master
      execFile('git', ['diff', 'master...HEAD', '--stat'], { cwd, timeout: 5000 }, (err2, stdout2) => {
        if (err2) {
          execFile('git', ['diff', 'main...HEAD', '--stat'], { cwd, timeout: 5000 }, (err3, stdout3) => {
            resolve(stdout3 && stdout3.trim().length > 0);
          });
        } else {
          resolve(stdout2 && stdout2.trim().length > 0);
        }
      });
    });
  });
}

/**
 * Delete a branch if it has no changes.
 */
function cleanupEmptyBranch(cwd, branch) {
  return new Promise(resolve => {
    execFile('git', ['branch', '-D', branch], { cwd, timeout: 5000 }, () => resolve());
  });
}

/**
 * Execute a skill on a project. Returns execution result.
 *
 * @param {Object} task - { id, project, skill, projectPath }
 * @param {Function} onProgress - callback(line) for live output
 * @returns {Object} { status, branch, costUsd, logFile, duration }
 */
async function execute(task, onProgress) {
  const skill = SKILLS[task.skill];
  if (!skill) {
    return { status: 'failed', error: `Unknown skill: ${task.skill}`, costUsd: 0 };
  }

  // Check budget
  const remaining = store.budgetRemaining();
  if (remaining < skill.budgetUsd) {
    return { status: 'skipped', error: 'Budget exceeded', costUsd: 0 };
  }

  ensureRunsDir();
  const logFile = path.join(RUNS_DIR, `${task.id}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const startTime = Date.now();

  // Create branch
  const branch = await createBranch(task.projectPath, task.skill);
  if (!branch) {
    logStream.end('ERROR: Could not create git branch\n');
    await returnToMainBranch(task.projectPath);
    return { status: 'failed', error: 'Could not create branch', costUsd: 0, logFile };
  }

  logStream.write(`=== ${task.skill} on ${task.project} ===\n`);
  logStream.write(`Branch: ${branch}\n`);
  logStream.write(`Started: ${new Date().toISOString()}\n\n`);

  return new Promise(resolve => {
    const args = [
      '--print',
      skill.prompt,
      '--model', skill.model,
      '--max-budget-usd', String(skill.budgetUsd),
      '--output-format', 'text',
      '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions'
    ];

    const proc = spawn('claude', args, {
      cwd: task.projectPath,
      shell: true,
      timeout: 5 * 60 * 1000, // 5 min max per task
      env: { ...process.env }
    });

    let output = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      logStream.write(text);
      if (onProgress) onProgress(text);
    });

    proc.stderr.on('data', (data) => {
      logStream.write(`[stderr] ${data.toString()}`);
    });

    proc.on('close', async (code) => {
      const duration = Math.round((Date.now() - startTime) / 1000);
      logStream.write(`\n=== Finished (code ${code}) in ${duration}s ===\n`);
      logStream.end();

      // Estimate cost (rough: Haiku ~$0.001, Sonnet ~$0.01-0.05 per run)
      const estimatedCost = skill.budgetUsd * 0.3; // conservative estimate: ~30% of budget
      store.addSpend(estimatedCost);

      // Check if branch has actual changes
      const hasChanges = await branchHasCommits(task.projectPath, branch);

      // Return to master
      await returnToMainBranch(task.projectPath);

      // Cleanup empty branch
      if (!hasChanges) {
        await cleanupEmptyBranch(task.projectPath, branch);
      }

      const result = {
        status: code === 0 ? 'done' : 'failed',
        branch: hasChanges ? branch : null,
        costUsd: estimatedCost,
        logFile,
        duration,
        hasChanges
      };

      // Log execution
      store.logExecution({
        ...result,
        project: task.project,
        skill: task.skill,
        taskId: task.id
      });

      resolve(result);
    });

    proc.on('error', async (err) => {
      logStream.write(`\n=== ERROR: ${err.message} ===\n`);
      logStream.end();

      await returnToMainBranch(task.projectPath);
      await cleanupEmptyBranch(task.projectPath, branch);

      resolve({
        status: 'failed',
        error: err.message,
        costUsd: 0,
        logFile
      });
    });

    // Store process reference for emergency stop
    execute._currentProc = proc;
    execute._currentTask = task;
  });
}

/**
 * Kill the currently running execution.
 */
function emergencyStop() {
  if (execute._currentProc) {
    try { execute._currentProc.kill('SIGTERM'); } catch {}
    execute._currentProc = null;
    execute._currentTask = null;
    return true;
  }
  return false;
}

module.exports = { execute, emergencyStop, SKILLS };
