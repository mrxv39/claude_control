// renderer/tab-stats.js — Tab Stats: ciclo 5h live, chart ciclos, costes,
// actividad por skill y heatmap de proyectos.
// innerHTML uses: dynamic values pass through esc(). Local Electron app, no remote content.

const { esc, COLORS } = require('./common.js');

function createStatsTab({ ipcRenderer }) {
  const panelContent = document.getElementById('panel-content');

  async function buildLiveCycleHtml(live) {
    let h = '<div class="stats-section">';
    h += '<div class="stats-section-title">Ciclo 5h en vivo</div>';
    if (live) {
      const fillColor = COLORS.pacing[live.action] || COLORS.dim;
      h += '<div class="stats-cycle-track">';
      h += `<div class="stats-cycle-fill" style="width:${live.usedPercent}%;background:${fillColor};"></div>`;
      h += `<div class="stats-cycle-target" style="left:${live.targetPercent}%;"></div>`;
      h += `<div class="stats-cycle-label">${live.usedPercent}% usado · Objetivo: ${live.targetPercent}% · ${live.remainingMin}m restantes · 7d: ${live.sevenDayPercent}%</div>`;
      h += '</div>';
      try {
        const sched = await ipcRenderer.invoke('get-scheduler-status');
        const d = sched.lastTickDebug;
        const mode = sched.currentMode || 'ninguno';
        const paused = sched.paused ? ' (PAUSADO)' : '';
        const pending = sched.pendingTasks;
        let debugLine = `Modo: ${mode}${paused} · Tareas pendientes: ${pending}`;
        if (d) debugLine += ` · offHours: ${d.outsideHours} · idle: ${d.idle} · busy: ${d.busy} · pacing: ${d.pacingAction}`;
        if (d && d.reason) debugLine += ` · ${d.reason}`;
        h += `<div style="font-size:10px;color:${COLORS.dim};margin-top:4px;">${debugLine}</div>`;
      } catch {}
    } else {
      h += `<div style="font-size:11px;color:${COLORS.dim};">Sin datos de rate limit activos</div>`;
    }
    h += '</div>';
    return h;
  }

  function buildCycleChartHtml(data) {
    let h = '<div class="stats-section">';
    h += '<div class="stats-section-title">Uso por ciclo (últimos 20)</div>';
    if (data && data.cycleChart.length > 0) {
      const cycles = data.cycleChart;
      const chartH = 100;
      const barW = Math.floor(340 / Math.max(cycles.length, 1));
      const gap = 2;
      const svgW = cycles.length * barW;
      h += `<div class="stats-chart-wrap"><svg width="${svgW}" height="${chartH + 18}" viewBox="0 0 ${svgW} ${chartH + 18}">`;
      const targetY = chartH - (95 / 100 * chartH);
      h += `<line x1="0" y1="${targetY}" x2="${svgW}" y2="${targetY}" stroke="${COLORS.yellow}" stroke-width="1" stroke-dasharray="4,3" opacity=".5"/>`;
      for (let i = 0; i < cycles.length; i++) {
        const pct = cycles[i].fiveHourPercent || 0;
        const bh = pct / 100 * chartH;
        const x = i * barW + gap / 2;
        const w = barW - gap;
        const y = chartH - bh;
        const date = cycles[i].capturedAt ? new Date(cycles[i].capturedAt).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }) : '';
        h += `<rect x="${x}" y="${y}" width="${w}" height="${bh}" rx="2" fill="${COLORS.blue}" opacity=".85"><title>${date}: ${pct}%</title></rect>`;
        if (cycles.length <= 20) {
          h += `<text x="${x + w / 2}" y="${chartH + 12}" text-anchor="middle" font-size="8" fill="${COLORS.dim}">${date}</text>`;
        }
      }
      h += '</svg></div>';
    } else {
      h += `<div style="font-size:11px;color:${COLORS.dim};">Sin datos de ciclos aún</div>`;
    }
    h += '</div>';
    return h;
  }

  async function renderStats() {
    let data, live;
    try { data = await ipcRenderer.invoke('get-dashboard-stats'); } catch { data = null; }
    try { live = await ipcRenderer.invoke('get-live-cycle'); } catch { live = null; }

    let html = '';
    html += await buildLiveCycleHtml(live);
    html += buildCycleChartHtml(data);

    if (data) {
      html += '<div class="stats-section">';
      html += '<div class="stats-section-title">Costes</div>';
      html += '<div class="stats-grid">';
      html += `<div class="stats-card"><h3>Hoy</h3><div class="stats-value">$${data.costSummary.todayUsd.toFixed(2)}</div></div>`;
      html += `<div class="stats-card"><h3>Esta semana</h3><div class="stats-value">$${data.costSummary.weekUsd.toFixed(2)}</div><div class="stats-sub">${data.costSummary.weekRuns} ejecuciones</div></div>`;
      html += `<div class="stats-card"><h3>Este mes</h3><div class="stats-value">$${data.costSummary.monthUsd.toFixed(2)}</div><div class="stats-sub">${data.costSummary.monthRuns} ejecuciones</div></div>`;
      html += `<div class="stats-card"><h3>Ramas creadas</h3><div class="stats-value">${data.totalBranches}</div></div>`;
      html += '</div></div>';
    }

    if (data && Object.keys(data.activityBySkill).length > 0) {
      html += '<div class="stats-section">';
      html += '<div class="stats-section-title">Actividad por skill</div>';
      html += '<table class="stats-table"><tr><th>Skill</th><th>Total</th><th>OK</th><th>Error</th><th>Éxito</th></tr>';
      for (const [skill, s] of Object.entries(data.activityBySkill)) {
        const rate = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
        const rc = rate > 80 ? COLORS.green : rate > 50 ? COLORS.yellow : COLORS.red;
        html += `<tr><td>${esc(skill)}</td><td>${s.total}</td><td>${s.done}</td><td>${s.failed}</td><td style="color:${rc};font-weight:600;">${rate}%</td></tr>`;
      }
      html += '</table></div>';
    }

    if (data && data.projectHeatmap.length > 0) {
      html += '<div class="stats-section">';
      html += '<div class="stats-section-title">Proyectos más atendidos</div>';
      const maxCount = data.projectHeatmap[0].count;
      for (const p of data.projectHeatmap) {
        const pct = maxCount > 0 ? (p.count / maxCount * 100) : 0;
        html += '<div class="stats-hbar-row">';
        html += `<div class="stats-hbar-name" title="${esc(p.project)}">${esc(p.project)}</div>`;
        html += `<div class="stats-hbar-track"><div class="stats-hbar-fill" style="width:${pct}%;"></div></div>`;
        html += `<div class="stats-hbar-count">${p.count}</div>`;
        html += '</div>';
      }
      html += '</div>';
    }

    if (!data || (data.cycleChart.length === 0 && Object.keys(data.activityBySkill).length === 0 && data.projectHeatmap.length === 0)) {
      html += '<div class="empty-msg">Sin datos históricos aún. Los datos se acumulan con las ejecuciones del orquestador.</div>';
    }

    panelContent.innerHTML = html;
  }

  return { renderStats };
}

module.exports = { createStatsTab };
