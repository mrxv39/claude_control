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
    prompt: `Analiza este proyecto y añade tests para los 2-3 paths más críticos.

**Paso 1 — Framework**: Detecta si hay framework de test configurado:
- Node: busca vitest/jest/mocha en package.json devDependencies
- Python: busca pytest/unittest en requirements.txt o pyproject.toml
- Rust: los tests son built-in (#[cfg(test)])
Si NO hay framework: instálalo (vitest para Node, pytest para Python) y configúralo (vitest.config.ts o pytest.ini). Añade script "test" en package.json si falta.

**Paso 2 — Tests**: Identifica funciones/módulos críticos sin cobertura (APIs, lógica de negocio, validaciones). Crea archivos de test con al menos 3 test cases cada uno.

**Paso 3 — Verificar**: Ejecuta los tests que creaste. Si fallan, arregla los tests (no el código fuente). Si el framework no se instaló correctamente, repórtalo en el output.

No modifiques código existente excepto package.json/pyproject.toml para añadir el framework.`
  },
  'git-cleanup': {
    model: 'sonnet',
    prompt: `Limpia este repositorio git: elimina ramas locales ya mergeadas (excepto master/main), verifica que .gitignore cubre node_modules, dist, build, .env, *.log, y otros patrones comunes para el stack del proyecto. Solo modifica .gitignore si le faltan entradas importantes.`
  },
  'supabase-audit': {
    model: 'opus',
    prompt: `Audita la seguridad de Supabase en este proyecto:
1. **RLS**: Lista todas las tablas y verifica que tienen RLS activado. Si alguna tabla con datos sensibles (users, transactions, personal data) no tiene RLS, repórtalo como CRÍTICO.
2. **Storage**: Busca buckets públicos. Si contienen documentos personales (DNI, facturas, contratos), cambia la policy a authenticated-only y usa signed URLs.
3. **Edge Functions**: Verifica que validan auth (req.headers.get('Authorization')). Busca secrets hardcodeados.
4. **Client-side**: Busca queries con .from() sin filtro de user_id que podrían exponer datos de otros usuarios.
Crea un archivo SECURITY-AUDIT.md con los hallazgos. Solo arregla issues CRÍTICOS directamente en el código.`
  },
  'perf-audit': {
    model: 'sonnet',
    prompt: `Analiza el rendimiento de este proyecto. Busca:
1. **Queries N+1**: loops que hacen queries individuales en vez de batch/join. Busca patrones como for-loop + await supabase.from() o prisma.find().
2. **Bundle**: imports pesados que podrían ser lazy (moment.js, lodash completo, iconos completos). Sugiere alternativas tree-shakeable.
3. **React renders**: componentes sin memo/useMemo que reciben objetos nuevos en cada render, listas sin key estable, useEffect sin deps array.
4. **Índices SQL**: queries con WHERE/ORDER BY en columnas sin índice visible en las migraciones.
No modifiques código. Crea PERF-REPORT.md con hallazgos ordenados por impacto (alto/medio/bajo) y la solución sugerida para cada uno.`
  },
  'fix-types': {
    model: 'sonnet',
    prompt: `Mejora el tipado de este proyecto:
- **TypeScript**: Busca usos de \`any\`, parámetros sin tipo, funciones sin tipo de retorno. Añade tipos concretos. No uses \`any\` ni \`unknown\` como solución.
- **Python**: Añade type hints a funciones que no los tienen (parámetros y retorno). Usa tipos de typing (Optional, List, Dict, Union).
Solo modifica tipos/hints, no cambies lógica ni comportamiento. Prioriza archivos de API, modelos de datos, y funciones exportadas.`
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

const WATCHDOG_MS = 8 * 60 * 1000; // 8 min hard kill
const IDLE_TIMEOUT_MS = 120 * 1000; // 2 min without output = hung

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
      '--max-turns', '30',
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
    const watchdog = setTimeout(() => {
      logStream.write(`\n=== WATCHDOG: killing after ${WATCHDOG_MS / 1000}s ===\n`);
      try { proc.kill(); } catch {}
    }, WATCHDOG_MS);

    // Idle timeout: kill if no output for IDLE_TIMEOUT_MS
    let lastOutputTime = Date.now();
    const idleCheck = setInterval(() => {
      if (Date.now() - lastOutputTime > IDLE_TIMEOUT_MS) {
        logStream.write(`\n=== IDLE TIMEOUT: no output for ${IDLE_TIMEOUT_MS / 1000}s ===\n`);
        try { proc.kill(); } catch {}
        clearInterval(idleCheck);
      }
    }, 10000);

    let output = '';

    proc.stdout.on('data', (data) => {
      lastOutputTime = Date.now();
      const text = data.toString();
      output += text;
      logStream.write(text);
      if (onProgress) onProgress(text);
    });

    proc.stderr.on('data', (data) => {
      lastOutputTime = Date.now();
      logStream.write(`[stderr] ${data.toString()}`);
    });

    proc.on('close', async (code) => {
      clearTimeout(watchdog);
      clearInterval(idleCheck);
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
    if (!execute._procs) execute._procs = new Map();
    execute._procs.set(task.id, proc);
    proc.on('close', () => execute._procs.delete(task.id));
  });
}

/**
 * Kill all currently running executions.
 */
function emergencyStop() {
  if (!execute._procs || execute._procs.size === 0) return false;
  for (const [id, proc] of execute._procs) {
    try { proc.kill('SIGTERM'); } catch {}
  }
  execute._procs.clear();
  return true;
}

module.exports = { execute, emergencyStop, SKILLS };
