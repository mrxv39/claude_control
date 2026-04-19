// lib/ipc/autonomous-handlers.js — IPC handlers del sistema autonomo F1+.
// Incluye store (config/projects/events), status/tick controls, token report,
// get-project-info (README/CLAUDE.md/git), analyze-project (Claude Haiku),
// suggest-goal (heuristico), y track (telemetria).
//
// getAutoOrchestrator() es un getter porque la instancia se construye en
// main.js despues del license gate y puede ser null inicialmente.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { gitExec, gitExecLines } = require('../git-exec');

function register(ipcMain, deps) {
  const {
    autonomousStore, tokenHistory, tokenReport, goalSuggester, telemetry,
    getAutoOrchestrator,
  } = deps;

  ipcMain.handle('auto:get-config', () => autonomousStore.getConfig());
  ipcMain.handle('auto:update-config', (_ev, partial) => autonomousStore.updateConfig(partial));
  ipcMain.handle('auto:get-project', (_ev, name) => autonomousStore.getProject(name));
  ipcMain.handle('auto:update-project', (_ev, name, patch) => autonomousStore.updateProject(name, patch));
  ipcMain.handle('auto:toggle-active', (_ev, name, active) => autonomousStore.toggleActive(name, active));
  ipcMain.handle('auto:set-objective', (_ev, name, objective) => autonomousStore.setObjective(name, objective));
  ipcMain.handle('auto:get-events', (_ev, n) => autonomousStore.readEvents(n || 200));

  ipcMain.handle('auto:get-status', () => {
    const orch = getAutoOrchestrator();
    if (!orch) return { running: false, dryRun: true };
    return {
      running: orch.isRunning(),
      dryRun: orch.isDryRun(),
      lastTickAt: orch.getLastTickAt(),
      lastTickResult: orch.getLastTickResult(),
    };
  });

  ipcMain.handle('auto:set-dry-run', (_ev, dryRun) => {
    const orch = getAutoOrchestrator();
    if (!orch) return false;
    orch.setDryRun(!!dryRun);
    return true;
  });

  ipcMain.handle('auto:tick-now', async () => {
    const orch = getAutoOrchestrator();
    if (!orch) return { action: 'skip', reason: 'orchestrator not running' };
    return orch.runTickNow();
  });

  ipcMain.handle('auto:start', () => {
    const orch = getAutoOrchestrator();
    if (!orch) return false;
    orch.start();
    return true;
  });

  ipcMain.handle('auto:stop', () => {
    const orch = getAutoOrchestrator();
    if (!orch) return false;
    orch.stop();
    return true;
  });

  ipcMain.handle('auto:token-report', (_ev, opts) => {
    const entries = tokenHistory.readHistory(500);
    const events = autonomousStore.readEvents(2000);
    return {
      summary: tokenReport.summarize(entries, opts),
      byDay: tokenReport.bucketByDay(entries),
      rankedCycles: tokenReport.rankCycles(entries, events, { limit: 30 }),
    };
  });

  ipcMain.handle('auto:token-avg', (_ev, windowDays) => {
    const entries = tokenHistory.readHistory(500);
    return tokenReport.computeAverage(entries, { windowDays: windowDays || 7 });
  });

  // Reads project files + git log for the detail drawer.
  ipcMain.handle('auto:get-project-info', async (_ev, name) => {
    const project = autonomousStore.getProject(name);
    if (!project || !project.path) return { name, error: 'no-path' };
    const p = project.path;
    const out = { name, path: p, stack: project.stack, score: project.score };

    const readmeCandidates = ['README.md', 'README.MD', 'Readme.md', 'readme.md', 'README'];
    for (const f of readmeCandidates) {
      try {
        const full = path.join(p, f);
        if (fs.existsSync(full)) {
          out.readme = fs.readFileSync(full, 'utf-8').slice(0, 2000);
          break;
        }
      } catch {}
    }

    try {
      const claudeMd = path.join(p, 'CLAUDE.md');
      if (fs.existsSync(claudeMd)) {
        out.claudeMd = fs.readFileSync(claudeMd, 'utf-8').slice(0, 2000);
      }
    } catch {}

    try {
      const pkg = path.join(p, 'package.json');
      const cargo = path.join(p, 'Cargo.toml');
      if (fs.existsSync(pkg)) {
        out.packageManifest = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
      } else if (fs.existsSync(cargo)) {
        out.packageManifest = { name: path.basename(p), _source: 'Cargo.toml' };
      }
    } catch {}

    const lastTsStr = await gitExec(p, ['log', '-1', '--format=%ct']);
    if (lastTsStr) {
      const ts = parseInt(lastTsStr, 10);
      out.lastCommitDays = isNaN(ts) ? null : Math.floor((Date.now() / 1000 - ts) / 86400);
    } else {
      out.lastCommitDays = null;
    }

    out.recentCommits = (await gitExecLines(p, ['log', '--since=14.days', '--oneline'])).length;
    out.recentCommitsList = (await gitExecLines(p, ['log', '-5', '--format=%h %s'])).slice(0, 5);

    return out;
  });

  // Analiza un proyecto con Claude Haiku — resumen humano de qué es.
  // ~1-2k tokens por llamada. Es tirar tokens a propósito para ayudar al usuario
  // a recordar/entender proyectos que tiene abandonados.
  ipcMain.handle('auto:analyze-project', async (_ev, name) => {
    const project = autonomousStore.getProject(name);
    if (!project?.path) return { error: 'no-path' };
    const p = project.path;

    const parts = [];
    parts.push(`# Proyecto: ${name}`);
    parts.push(`Path: ${p}`);
    parts.push(`Stack detectado: ${project.stack || 'unknown'}`);

    const addFileIf = (relPath, header) => {
      try {
        const f = path.join(p, relPath);
        if (fs.existsSync(f)) {
          const content = fs.readFileSync(f, 'utf-8').slice(0, 3000);
          parts.push(`\n## ${header} (${relPath})\n${content}`);
        }
      } catch {}
    };
    addFileIf('README.md', 'README');
    addFileIf('CLAUDE.md', 'CLAUDE.md');
    addFileIf('package.json', 'package.json');
    addFileIf('Cargo.toml', 'Cargo.toml');
    addFileIf('pyproject.toml', 'pyproject.toml');

    try {
      const entries = fs.readdirSync(p).slice(0, 40);
      parts.push(`\n## Archivos en raíz\n${entries.join('\n')}`);
    } catch {}

    const recentLog = await gitExec(p, ['log', '-10', '--format=%h %ci %s']);
    if (recentLog) parts.push(`\n## Últimos 10 commits\n${recentLog}`);

    const context = parts.join('\n').slice(0, 15000);
    const prompt = `Analiza este proyecto y escríbeme 3-4 frases MUY concretas en español respondiendo:

1. ¿Qué hace este proyecto? (o qué pretendía hacer si está abandonado)
2. ¿En qué estado está? (vivo, dormido, abandonado, experimento)
3. ¿Vale la pena activarlo en un orquestador autónomo? Recomendación clara:
   - activar con plantilla X (nombre concreto: production-ready | MVP-lanzable | mantenimiento | explorar-idea | seguro-y-testeado)
   - ignorar / pausar (razón breve)

SÉ DIRECTO. Sin preámbulos. Sin markdown. Prosa natural corta.

---

${context}`;

    return new Promise((resolve) => {
      const args = [
        '--print', '-p', prompt,
        '--model', 'haiku',
        '--max-turns', '1',
        '--output-format', 'text',
        '--dangerously-skip-permissions',
      ];
      const proc = spawn('claude', args, {
        cwd: p, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      });
      proc.stdin.end();
      let out = '', err = '';
      const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve({ error: 'timeout' }); }, 60000);
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('error', e => { clearTimeout(timer); resolve({ error: e.message }); });
      proc.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return resolve({ error: `exit ${code}: ${err.slice(0, 200)}` });
        resolve({ summary: out.trim() });
      });
    });
  });

  // Heurística local (sin LLM) para sugerir plantilla. Rápida y gratis.
  ipcMain.handle('auto:suggest-goal', async (_ev, name) => {
    try {
      const project = autonomousStore.getProject(name);
      const info = {
        name,
        stack: project.stack,
        score: project.score,
        readme: null,
        packageManifest: null,
        recentCommits: 0,
        lastCommitDays: null,
        checks: project.checks || {},
      };
      if (project.path) {
        try {
          const readme = path.join(project.path, 'README.md');
          if (fs.existsSync(readme)) info.readme = fs.readFileSync(readme, 'utf-8').slice(0, 2000);
        } catch {}
        try {
          const pkg = path.join(project.path, 'package.json');
          if (fs.existsSync(pkg)) info.packageManifest = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
        } catch {}
      }
      return goalSuggester.heuristicSuggest(info);
    } catch (e) {
      return { template: 'MVP-lanzable', confidence: 0.2, reasoning: `error: ${e.message}`, source: 'heuristic' };
    }
  });

  ipcMain.handle('track', (_ev, type, payload) => {
    try { telemetry.trackEvent(type, payload || {}); }
    catch {}
  });
}

module.exports = { register };
