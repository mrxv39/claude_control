/**
 * autonomous-orchestrator.js — Loop + lifecycle del orquestador autónomo.
 *
 * Envuelve `orchestrator.tick` en un timer re-planificable (no `setInterval`),
 * con concurrency guard (no ticks solapados), log interno de eventos recientes,
 * switch dry-run runtime y captura de errores.
 *
 * Las dependencias de la tick se inyectan íntegramente al constructor — esta
 * clase es el punto de integración donde se juntan project-analyzer,
 * orchestrator-store, planner y executor reales. Tests usan mocks.
 *
 * @typedef {Object} AutonomousDeps
 * @property {() => Promise<any>} getConfig
 * @property {(project: {name, path, stack}) => Promise<{checks, score}>} analyze
 * @property {(name: string, patch: any) => Promise<void>} updateProject
 * @property {{decide: Function, buildConstraints: Function}} [planner]
 * @property {{execute: Function}} [executor] - ignorado si dryRun=true
 * @property {() => number} [getIntervalMs] - interval dinámico; default 60s
 * @property {boolean} [dryRun]
 * @property {(event: any) => void} [onEvent]
 * @property {(result: any) => void} [onTickComplete]
 * @property {number} [maxEventLog] - cap del log interno; default 1000
 */

const orchestrator = require('./orchestrator');

const DEFAULT_INTERVAL_MS = 60000;
const FIRST_TICK_DELAY_MS = 100;
const ERROR_BACKOFF_MS = 5000;
const DEFAULT_MAX_LOG = 1000;

class AutonomousOrchestrator {
  /** @param {AutonomousDeps} deps */
  constructor(deps) {
    if (!deps || typeof deps.getConfig !== 'function') {
      throw new Error('AutonomousOrchestrator requires at least {getConfig}');
    }
    this.deps = { dryRun: false, maxEventLog: DEFAULT_MAX_LOG, ...deps };
    this._running = false;
    this._timer = null;
    this._tickInProgress = false;
    /** @type {any[]} */
    this._eventLog = [];
    this._lastTickResult = null;
    this._lastTickAt = null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._scheduleNext(FIRST_TICK_DELAY_MS);
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  isRunning() {
    return this._running;
  }

  setDryRun(value) {
    this.deps.dryRun = !!value;
  }

  isDryRun() {
    return !!this.deps.dryRun;
  }

  getRecentEvents(n = 100) {
    if (typeof n !== 'number' || n <= 0) return [];
    return this._eventLog.slice(-n);
  }

  getLastTickResult() {
    return this._lastTickResult;
  }

  getLastTickAt() {
    return this._lastTickAt;
  }

  /**
   * Lanza un tick manual fuera del schedule. No interrumpe loop ni solapa.
   * Útil para "Re-escanear" desde la UI.
   * @returns {Promise<any>}
   */
  async runTickNow() {
    if (this._tickInProgress) {
      return { action: 'skip', reason: 'tick-in-progress' };
    }
    return this._doTick();
  }

  _scheduleNext(delayMs) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._doTick().catch(() => {}), delayMs);
  }

  async _doTick() {
    if (!this._running && !this._manualTick) {
      // Allow explicit runTickNow when not running
    }
    if (this._tickInProgress) return { action: 'skip', reason: 'tick-in-progress' };
    this._tickInProgress = true;
    let result;
    try {
      result = await orchestrator.tick({
        getConfig: this.deps.getConfig,
        analyze: this.deps.analyze,
        updateProject: this.deps.updateProject,
        recordEvent: (e) => this._onEvent(e),
        planner: this.deps.planner,
        executor: this.deps.dryRun ? null : this.deps.executor,
      });
      this._lastTickResult = result;
      this._lastTickAt = Date.now();
      if (this.deps.onTickComplete) {
        try { this.deps.onTickComplete(result); } catch {}
      }
    } catch (e) {
      result = { action: 'error', error: e?.message || String(e) };
      this._onEvent({ type: 'tick-error', error: result.error, at: Date.now() });
    } finally {
      this._tickInProgress = false;
      if (this._running) {
        const wasError = result?.action === 'error';
        const interval = wasError
          ? ERROR_BACKOFF_MS
          : (this.deps.getIntervalMs?.() ?? DEFAULT_INTERVAL_MS);
        this._scheduleNext(interval);
      }
    }
    return result;
  }

  _onEvent(event) {
    this._eventLog.push(event);
    const cap = this.deps.maxEventLog;
    if (this._eventLog.length > cap) {
      this._eventLog.splice(0, this._eventLog.length - cap);
    }
    if (this.deps.onEvent) {
      try { this.deps.onEvent(event); } catch {}
    }
  }
}

module.exports = {
  AutonomousOrchestrator,
  DEFAULT_INTERVAL_MS,
  ERROR_BACKOFF_MS,
};
