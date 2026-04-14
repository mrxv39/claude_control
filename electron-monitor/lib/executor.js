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

// Skill definitions: prompt, model
// Models: opus for deep analysis, sonnet for lighter tasks
const SKILLS = {
  'audit-claude-md': {
    model: 'sonnet',
    prompt: `Analiza este proyecto y su CLAUDE.md (si existe). Si no existe, crea uno con: arquitectura, comandos de build/test/dev, convenciones, archivos clave, y gotchas. Si existe, mejóralo con información que falte. Se conciso y práctico. Solo modifica CLAUDE.md, nada más.`
  },
  'security-review': {
    model: 'opus',
    prompt: `Haz un review de seguridad de este proyecto. Busca: command injection, XSS, SQL injection, secrets hardcodeados, permisos excesivos, dependencias con vulnerabilidades conocidas. Solo arregla issues CRÍTICOS (no warnings menores). Trabaja en los archivos fuente, no en tests ni configs.`
  },
  'dep-update': {
    model: 'sonnet',
    prompt: `Revisa las dependencias de este proyecto. Actualiza las que estén desactualizadas (minor/patch, no major). Si hay tests, ejecútalos después de actualizar para verificar que nada se rompe. Si un test falla, revierte esa actualización específica.`
  },
  'simplify': {
    model: 'opus',
    prompt: `Revisa el código de este proyecto buscando oportunidades de simplificación: código duplicado, funciones demasiado largas, complejidad innecesaria, imports no usados. Aplica solo simplificaciones seguras que no cambien el comportamiento. No toques tests.`
  },
  'add-tests': {
    model: 'opus',
    prompt: `Analiza este proyecto e identifica las funciones/módulos más críticos que no tienen tests. Añade tests para los 2-3 paths más importantes. Usa el framework de testing que ya use el proyecto (vitest, jest, pytest, etc). Si no hay framework, sugiere uno pero no lo instales. No modifiques código existente, solo añade tests nuevos.`
  },
  'git-cleanup': {
    model: 'sonnet',
    prompt: `Limpia este repositorio git: elimina ramas locales ya mergeadas (excepto master/main), verifica que .gitignore cubre node_modules, dist, build, .env, *.log, y otros patrones comunes para el stack del proyecto. Solo modifica .gitignore si le faltan entradas importantes.`
  },
  'ui-polish': {
    model: 'sonnet',
    prompt: `Revisa los archivos de UI de este proyecto (HTML, CSS, JSX, TSX, Vue, Svelte, templates). Mejora en un solo pase:
1. **Visual**: colores sueltos → CSS variables, spacing inconsistente → tokens uniformes, estados hover/focus/active faltantes en elementos interactivos, tipografía sin jerarquía clara.
2. **Accesibilidad**: elementos interactivos sin keyboard access, divs/spans que deberían ser button/nav/main, aria-labels faltantes en botones de solo icono, contraste de color insuficiente.
3. **Animaciones**: propiedades caras (width/height/top/left) → transform/opacity, transiciones faltantes en cambios de estado, añadir prefers-reduced-motion donde haya animaciones.
Solo aplica cambios que mejoren sin cambiar funcionalidad. No toques lógica de negocio ni backend. Prioriza: estados interactivos > accesibilidad > consistencia visual > animaciones.`
  }
};

const WATCHDOG_MS = 5 * 60 * 1000; // 5 min hard kill

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
 * Return to the main branch (master or main).
 */
async function returnToMainBranch(cwd) {
  const main = await getMainBranch(cwd);
  return new Promise(resolve => {
    execFile('git', ['checkout', main], { cwd, timeout: 10000 }, () => resolve());
  });
}

/**
 * Detect the main branch name (master or main).
 */
function getMainBranch(cwd) {
  return new Promise(resolve => {
    execFile('git', ['rev-parse', '--verify', 'master'], { cwd, timeout: 5000 }, (err) => {
      resolve(err ? 'main' : 'master');
    });
  });
}

/**
 * Check if current branch has changes vs the main branch.
 */
function branchHasCommits(cwd) {
  return new Promise(async resolve => {
    const main = await getMainBranch(cwd);
    execFile('git', ['diff', `${main}...HEAD`, '--stat'], { cwd, timeout: 5000 }, (err, stdout) => {
      resolve(!err && stdout && stdout.trim().length > 0);
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
      '-p', skill.prompt,
      '--model', skill.model,
      '--output-format', 'text',
      '--dangerously-skip-permissions'
    ];

    const proc = spawn('claude', args, {
      cwd: task.projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });

    // Close stdin immediately — --print doesn't need input
    proc.stdin.end();

    // Manual watchdog: kill process after WATCHDOG_MS
    // On Windows, kill() always does TerminateProcess (SIGTERM/SIGKILL are equivalent)
    const watchdog = setTimeout(() => {
      logStream.write(`\n=== WATCHDOG: killing after ${WATCHDOG_MS / 1000}s ===\n`);
      try { proc.kill(); } catch {}
    }, WATCHDOG_MS);

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
      clearTimeout(watchdog);
      const duration = Math.round((Date.now() - startTime) / 1000);
      logStream.write(`\n=== Finished (code ${code}) in ${duration}s ===\n`);
      logStream.end();

      // Check if branch has actual changes
      const hasChanges = await branchHasCommits(task.projectPath);

      // Return to master
      await returnToMainBranch(task.projectPath);

      // Cleanup empty branch
      if (!hasChanges) {
        await cleanupEmptyBranch(task.projectPath, branch);
      }

      const result = {
        status: code === 0 ? 'done' : 'failed',
        branch: hasChanges ? branch : null,
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
      clearTimeout(watchdog);
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
