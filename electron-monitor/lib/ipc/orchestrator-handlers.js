// lib/ipc/orchestrator-handlers.js — IPC handlers del orquestador clasico:
// config, queue, scheduler, priorities, stats, git, session log.
// register(ipcMain, deps) enchufa todos los handlers de una vez.

function register(ipcMain, deps) {
  const {
    store, scanner, analyzer, scheduler, telemetry,
    tokenHistory, statsAggregator, executor,
    gitStatus, conversationReader,
  } = deps;

  ipcMain.handle('get-orchestrator-config', () => store.load());

  ipcMain.handle('set-orchestrator-config', (ev, partial) => {
    const allowed = [
      'workHours', 'dailyBudgetUsd', 'blacklist',
      'idleEnabled', 'idleMinutes', 'capacityEnabled', 'capacityThreshold',
      'pacingEnabled', 'pacingMaxTarget', 'pacingExponent', 'timezone',
    ];
    const safe = {};
    for (const k of allowed) if (k in partial) safe[k] = partial[k];
    return store.update(safe);
  });

  ipcMain.handle('get-project-analysis', () => store.getProjects());

  ipcMain.handle('run-project-scan', async () => {
    const config = store.load();
    const projects = await scanner.scan(config.projectDirs);
    const analysis = await analyzer.analyzeAll(projects);
    store.setProjects(analysis);
    store.update({ lastFullScan: new Date().toISOString() });
    return analysis;
  });

  ipcMain.handle('get-queue', () => store.getQueue());
  ipcMain.handle('get-execution-log', () => store.readLog(50));

  ipcMain.handle('get-budget-status', () => {
    const config = store.load();
    return {
      todaySpent: config.todaySpentUsd,
      dailyBudget: config.dailyBudgetUsd,
      remaining: store.budgetRemaining(),
    };
  });

  ipcMain.handle('get-scheduler-status', () => scheduler.getStatus());
  ipcMain.handle('pause-scheduler', () => { scheduler.pause(); telemetry.trackEvent('scheduler_pause', {}); return true; });
  ipcMain.handle('resume-scheduler', () => { scheduler.resume(); telemetry.trackEvent('scheduler_resume', {}); return true; });
  ipcMain.handle('emergency-stop', () => { scheduler.pause(); return true; });

  ipcMain.handle('get-token-history', () => tokenHistory.readHistory(50));
  ipcMain.handle('get-token-history-stats', () => tokenHistory.getStats());

  ipcMain.handle('get-dashboard-stats', () => statsAggregator.getDashboardStats());
  ipcMain.handle('get-live-cycle', () => statsAggregator.getLiveCycle());

  ipcMain.handle('add-to-queue', (ev, task) => store.enqueue(task));
  ipcMain.handle('remove-from-queue', (ev, taskId) => { store.dequeue(taskId); return true; });

  ipcMain.handle('get-skills', () => {
    return Object.entries(executor.SKILLS).map(([name, def]) => ({
      name,
      model: def.model,
      budgetUsd: def.budgetUsd,
    }));
  });

  ipcMain.handle('set-project-priority', (ev, { name, priority }) => {
    const config = store.load();
    if (!config.priorityOverrides) config.priorityOverrides = {};
    if (priority === 'auto') {
      delete config.priorityOverrides[name];
    } else {
      config.priorityOverrides[name] = priority;
    }
    store.save(config);
    return true;
  });

  ipcMain.handle('get-project-priorities', () => {
    const config = store.load();
    const result = {};
    for (const [name, proj] of Object.entries(config.projects)) {
      result[name] = scheduler.getProjectPriority(name, proj, config);
    }
    return result;
  });

  ipcMain.handle('get-git-status', async (ev, cwd) => {
    try { return await gitStatus.getStatus(cwd); }
    catch { return { branch: null, dirty: 0, recentCommits: [] }; }
  });

  ipcMain.handle('get-session-log', (ev, cwd) => {
    try { return conversationReader.getConversationLog(cwd); }
    catch { return []; }
  });
}

module.exports = { register };
