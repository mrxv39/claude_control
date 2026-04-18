// renderer/tab-health.js — Tab Salud: tarjetas de proyectos con score, checks,
// prioridades editables y boton de re-escaneo. Filtros por prioridad.
// Render via string concatenation; dynamic values pass through esc(). Local Electron app.

const { esc, COLORS } = require('./common.js');

function createHealthTab({ ipcRenderer }) {
  const panelContent = document.getElementById('panel-content');
  let healthFilter = 'all';

  function checkBadge(label, value) {
    if (value === true) return `<span class="check check-ok">${esc(label)}</span>`;
    if (value === false) return `<span class="check check-fail">${esc(label)}</span>`;
    return `<span class="check check-na">${esc(label)}</span>`;
  }

  function buildProjectCard(name, proj, priorities, config) {
    const s = proj.score || 5;
    const scoreClass = s >= 7 ? 'score-high' : s >= 4 ? 'score-mid' : 'score-low';
    const checks = proj.checks || {};
    const prio = priorities[name] || 'ignored';
    const prioColor = COLORS.priority[prio] || COLORS.dim;
    const isOverride = (config.priorityOverrides || {})[name] ? true : false;

    let h = `<div class="project-card" style="${prio === 'ignored' ? 'opacity:.5;' : ''}">`;
    h += '<div class="project-card-header">';
    h += `<span class="project-card-name">${esc(name)}</span>`;
    h += `<select class="prio-select" data-project="${esc(name)}" style="font-size:10px;padding:1px 4px;border-radius:3px;border:1px solid ${prioColor}44;background:${prioColor}22;color:${prioColor};cursor:pointer;${isOverride ? 'font-weight:700;' : ''}">`;
    h += `<option value="high"${prio === 'high' ? ' selected' : ''}>ALTA</option>`;
    h += `<option value="medium"${prio === 'medium' ? ' selected' : ''}>MEDIA</option>`;
    h += `<option value="low"${prio === 'low' ? ' selected' : ''}>BAJA</option>`;
    h += `<option value="ignored"${prio === 'ignored' ? ' selected' : ''}>IGNORADO</option>`;
    if (isOverride) h += '<option value="auto">AUTO</option>';
    h += '</select>';
    h += `<span class="project-card-stack">${esc(proj.stack || '?')}</span>`;
    h += `<span class="score-badge ${scoreClass}">${s}/10</span>`;
    h += '</div>';

    h += '<div class="check-row">';
    h += checkBadge('CLAUDE.md', checks.hasClaude);
    h += checkBadge('.gitignore', checks.hasGitignore);
    h += checkBadge('Tests', checks.hasTests);
    h += checkBadge('Git limpio', checks.gitClean);
    h += checkBadge('Deps ok', checks.depsOk);
    if (checks.lastCommitDays !== null && checks.lastCommitDays !== undefined) {
      h += `<span class="check ${checks.lastCommitDays <= 7 ? 'check-ok' : checks.lastCommitDays > 30 ? 'check-fail' : 'check-na'}">${checks.lastCommitDays}d</span>`;
    }
    h += '</div>';

    if (proj.suggestions && proj.suggestions.length) {
      for (const sug of proj.suggestions) h += `<div class="suggestion">${esc(sug)}</div>`;
    }
    h += '</div>';
    return h;
  }

  async function startScan() {
    const btn = document.getElementById('scan-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Escaneando...'; }
    try {
      await ipcRenderer.invoke('run-project-scan');
      await renderHealth();
    } catch {
      if (btn) { btn.disabled = false; btn.textContent = 'Error — reintentar'; }
    }
  }

  async function renderHealth() {
    const projects = await ipcRenderer.invoke('get-project-analysis');
    const priorities = await ipcRenderer.invoke('get-project-priorities');
    const config = await ipcRenderer.invoke('get-orchestrator-config');
    const entries = Object.entries(projects);

    if (!entries.length) {
      panelContent.innerHTML = '<div class="empty-msg">No hay datos de proyectos.<br><br><button class="scan-btn" id="scan-btn">Escanear proyectos</button></div>';
      document.getElementById('scan-btn').addEventListener('click', startScan);
      return;
    }

    const counts = { high: 0, medium: 0, low: 0, ignored: 0 };
    entries.forEach(([name]) => { const p = priorities[name] || 'ignored'; counts[p] = (counts[p] || 0) + 1; });

    const filtered = healthFilter === 'all' ? entries :
      entries.filter(([name]) => (priorities[name] || 'ignored') === healthFilter);

    const priorityOrder = { high: 0, medium: 1, low: 2, ignored: 3 };
    filtered.sort((a, b) => {
      const pA = priorityOrder[priorities[a[0]] || 'ignored'] || 3;
      const pB = priorityOrder[priorities[b[0]] || 'ignored'] || 3;
      if (pA !== pB) return pA - pB;
      return (a[1].score || 5) - (b[1].score || 5);
    });

    let html = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap;">';
    html += '<button class="scan-btn" id="scan-btn">Re-escanear</button>';
    const fBtn = (id, label, count) => {
      const active = healthFilter === id ? 'color:#7aa2f7;border-color:rgba(122,162,247,.4);background:rgba(122,162,247,.15);' : '';
      return `<button class="scan-btn health-filter" data-filter="${id}" style="font-size:10px;padding:2px 8px;${active}">${label} (${count})</button>`;
    };
    html += fBtn('all', 'Todos', entries.length);
    html += fBtn('high', 'Alta', counts.high);
    html += fBtn('medium', 'Media', counts.medium);
    html += fBtn('low', 'Baja', counts.low);
    html += fBtn('ignored', 'Ignorados', counts.ignored);
    html += '</div>';

    for (const [name, proj] of filtered) {
      html += buildProjectCard(name, proj, priorities, config);
    }

    panelContent.innerHTML = html;
    document.getElementById('scan-btn').addEventListener('click', startScan);
    panelContent.querySelectorAll('.health-filter').forEach(btn => {
      btn.addEventListener('click', () => { healthFilter = btn.dataset.filter; renderHealth(); });
    });
    panelContent.querySelectorAll('.prio-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        await ipcRenderer.invoke('set-project-priority', { name: sel.dataset.project, priority: sel.value });
        renderHealth();
      });
    });
  }

  return { renderHealth };
}

module.exports = { createHealthTab };
