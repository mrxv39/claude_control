// Smoke test: construye AutonomousOrchestrator con deps reales y corre 1 tick.
// No es test unitario — valida composición con orchestrator.json real.
// Dry-run siempre (no ejecuta skills).

const as = require('./lib/autonomous-store');
const { AutonomousOrchestrator } = require('./lib/autonomous-orchestrator');
const analyzer = require('./lib/project-analyzer');

(async () => {
  console.log('=== Smoke test: autonomous orchestrator ===');

  // 1. Cargar config real
  const cfg = as.getConfig();
  const projectNames = Object.keys(cfg.projects || {});
  const activeNames = projectNames.filter(n => cfg.projects[n].active);
  console.log(`Config loaded: ${projectNames.length} projects total, ${activeNames.length} active`);
  console.log(`tokenTargetPct=${cfg.tokenTargetPct} · avgWindow=${cfg.tokenAvgWindowDays}d`);

  // 2. Construir orchestrator en dry-run
  const events = [];
  const orch = new AutonomousOrchestrator({
    getConfig: async () => as.getConfig(),
    analyze: async (project) => analyzer.analyze({ name: project.name, path: project.path }),
    updateProject: async (name, patch) => as.updateProject(name, patch),
    dryRun: true,
    onEvent: (e) => events.push(e),
  });
  console.log('Orchestrator constructed OK');

  // 3. Ejecutar 1 tick
  console.log('\n--- Running 1 tick ---');
  const result = await orch.runTickNow();
  console.log('Tick result:', JSON.stringify(result, null, 2));
  console.log(`Events captured: ${events.length}`);
  for (const e of events) {
    console.log(`  ${e.type} ${e.reason || ''} ${e.project || ''}`);
  }

  // 4. Persist uno de los eventos a autonomous-events.jsonl para verificar I/O
  if (events.length) {
    as.appendEvent(events[0]);
    const readBack = as.readEvents(1);
    console.log('\nPersistence test: wrote + read back =', readBack.length === 1 ? 'OK' : 'FAIL');
  }

  console.log('\n=== SMOKE TEST PASSED ===');
  process.exit(0);
})().catch(e => {
  console.error('SMOKE TEST FAILED:', e);
  console.error(e.stack);
  process.exit(1);
});
