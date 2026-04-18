// renderer/tab-queue.js — Tab Cola: estado scheduler + config inline + cola de tareas.
// Render via string concatenation; dynamic values pass through esc(). Local Electron app.

const { esc } = require('./common.js');

function createQueueTab({ ipcRenderer }) {
  const panelContent = document.getElementById('panel-content');
  let configSectionOpen = false;

  function buildSchedulerHeaderHtml(status) {
    const stateColor = status.paused ? 'var(--red)' : status.outsideWorkHours ? 'var(--green)' : 'var(--yellow)';
    const stateLabel = status.paused ? 'PAUSADO' :
                       status.running ? 'EJECUTANDO' :
                       status.outsideWorkHours ? 'ACTIVO' : 'ESPERANDO';
    const stateDetail = status.paused ? '' :
                        status.running ? '' :
                        status.outsideWorkHours ? 'fuera de horario' : 'horario laboral';
    const rl = status.rateLimits;
    const rlStr = rl ? `5h: ${rl.fiveHour.usedPercent}%` : '';
    let h = '<div class="sched-header">';
    h += `<div class="sched-dot" style="background:${stateColor};box-shadow:0 0 8px ${stateColor}44;"></div>`;
    h += '<div>';
    h += `<div class="sched-label" style="color:${stateColor};">${stateLabel}</div>`;
    h += `<div class="sched-meta">${stateDetail}${stateDetail && rlStr ? ' · ' : ''}${rlStr}</div>`;
    h += '</div>';
    h += '<div class="sched-actions">';
    if (status.paused) {
      h += '<button class="scan-btn" id="resume-btn">Reanudar</button>';
    } else {
      h += '<button class="scan-btn" id="pause-btn" style="border-color:rgba(247,118,142,.2);color:var(--red);">Pausar</button>';
    }
    h += '<button class="scan-btn" id="add-task-btn">+ Tarea</button>';
    h += '</div></div>';
    return h;
  }

  function buildConfigSectionHtml(status, config) {
    const bl = (config.blacklist || []).join(', ');
    const idleChecked = status.idleEnabled ? 'checked' : '';
    const capChecked = status.capacityEnabled ? 'checked' : '';
    const p = status.pacingDecision;
    const pacingStr = p && p.cycle ? `${p.action} · ${p.cycle.remainingMin}m · target ${p.targetUsage}%` : '';
    let h = '<div class="config-section">';
    h += '<div class="config-toggle" id="config-toggle">';
    h += '<span class="config-toggle-label">Configuracion</span>';
    h += `<span style="font-size:10px;color:var(--text-dim);">${status.workHours.start}:00–${status.workHours.end}:00${pacingStr ? ' · ' + pacingStr : ''}</span>`;
    h += '<span class="config-toggle-arrow" id="config-arrow">&#9660;</span>';
    h += '</div>';
    h += '<div class="config-body" id="config-body">';
    h += '<div class="config-row"><span class="config-label">Horario</span>';
    h += `<input type="number" class="config-input" id="wh-start" value="${status.workHours.start}" min="0" max="23">`;
    h += '<span style="font-size:10px;color:var(--text-dim);">a</span>';
    h += `<input type="number" class="config-input" id="wh-end" value="${status.workHours.end}" min="0" max="23">`;
    h += '<span class="config-label" style="margin-left:12px;">Budget $</span>';
    h += `<input type="number" class="config-input" id="budget-input" value="${status.dailyBudget}" min="0" step="0.5" style="width:50px;">`;
    h += '</div>';
    h += '<div class="config-row"><span class="config-label">Blacklist</span>';
    h += `<input type="text" class="config-input" id="blacklist-input" value="${esc(bl)}" placeholder="proyecto1, proyecto2">`;
    h += '</div>';
    h += '<div class="config-row"><span class="config-label">Idle</span>';
    h += `<input type="checkbox" id="idle-enabled" ${idleChecked} style="-webkit-app-region:no-drag;">`;
    h += '<span style="font-size:10px;color:var(--text-dim);">tras</span>';
    h += `<input type="number" class="config-input" id="idle-minutes" value="${status.idleMinutes}" min="5" max="120">`;
    h += '<span style="font-size:10px;color:var(--text-dim);">min</span>';
    h += `<span class="config-value" style="color:var(--purple);">Actual: ${status.userIdleFor}m</span>`;
    h += '</div>';
    h += '<div class="config-row"><span class="config-label">Pacing</span>';
    h += `<input type="checkbox" id="capacity-enabled" ${capChecked} style="-webkit-app-region:no-drag;">`;
    h += '<span style="font-size:10px;color:var(--text-dim);">Tick:</span>';
    h += `<span style="font-size:10px;color:var(--yellow);">${Math.round((status.tickInterval || 60000) / 1000)}s</span>`;
    h += `<input type="number" class="config-input" id="capacity-threshold" value="${status.capacityThreshold}" min="10" max="90" style="display:none;">`;
    h += '</div>';
    h += '<div style="padding-top:6px;"><button class="scan-btn" id="save-config-btn" style="font-size:10px;padding:3px 12px;">Guardar</button></div>';
    h += '</div></div>';
    return h;
  }

  async function renderQueue() {
    let queue, status, config;
    try {
      [queue, status, config] = await Promise.all([
        ipcRenderer.invoke('get-queue'),
        ipcRenderer.invoke('get-scheduler-status'),
        ipcRenderer.invoke('get-orchestrator-config'),
      ]);
    } catch {
      panelContent.textContent = 'Error al cargar datos de la cola.';
      return;
    }

    let html = buildSchedulerHeaderHtml(status);
    html += buildConfigSectionHtml(status, config);

    if (!queue.length) {
      html += '<div class="empty-msg">No hay tareas en cola.<br><span style="font-size:11px;color:#565f89;">Se encolarán automáticamente fuera de horario según la salud de los proyectos.</span></div>';
    } else {
      const active = queue.filter(t => t.status === 'running' || t.status === 'pending');
      const completed = queue.filter(t => t.status === 'done' || t.status === 'failed' || t.status === 'skipped');

      if (active.length) {
        const orderA = { running: 0, pending: 1 };
        active.sort((a, b) => (orderA[a.status] || 2) - (orderA[b.status] || 2));
        html += `<div class="queue-section-label">Pendientes (${active.length})</div>`;
        for (const task of active) {
          const statusClass = task.status === 'pending' ? 'queue-pending' : 'queue-running';
          html += '<div class="queue-item">';
          html += `<span class="queue-status ${statusClass}">${esc(task.status)}</span>`;
          html += `<span class="queue-info">${esc(task.project || '?')} — ${esc(task.skill || '?')}</span>`;
          if (task.status === 'pending') html += `<span class="queue-cost" style="color:#f7768e;cursor:pointer;" data-remove="${task.id}">✕</span>`;
          html += '</div>';
        }
      }

      if (completed.length) {
        completed.sort((a, b) => {
          const ta = a.completedAt || a.startedAt || '';
          const tb = b.completedAt || b.startedAt || '';
          return tb.localeCompare(ta);
        });
        html += `<div class="queue-section-label" style="margin-top:8px;">Completadas (${completed.length})</div>`;
        for (const task of completed.slice(0, 30)) {
          const statusClass = task.status === 'done' ? 'queue-done' : 'queue-failed';
          const time = (task.completedAt || task.startedAt || '').slice(11, 16);
          const durStr = task.duration ? `${task.duration}s` : '';
          const changesBadge = task.hasChanges ? ' <span style="color:#9ece6a;font-size:9px;">+cambios</span>' : '';
          html += '<div class="queue-item">';
          html += `<span style="font-size:9px;color:#565f89;min-width:36px;">${time}</span>`;
          html += `<span class="queue-status ${statusClass}">${esc(task.status)}</span>`;
          html += `<span class="queue-info">${esc(task.project || '?')} — ${esc(task.skill || '?')}${changesBadge}`;
          if (task.branch) html += ` <span style="color:#7aa2f7;font-size:9px;">${esc(task.branch)}</span>`;
          html += '</span>';
          if (durStr) html += `<span class="queue-cost">${durStr}</span>`;
          html += '</div>';
        }
      }
    }

    // Render (html has only esc()-scrubbed dynamic values).
    panelContent.innerHTML = html;

    const pauseBtn = document.getElementById('pause-btn');
    const resumeBtn = document.getElementById('resume-btn');
    const addTaskBtn = document.getElementById('add-task-btn');
    const saveConfigBtn = document.getElementById('save-config-btn');

    const configToggle = document.getElementById('config-toggle');
    const configBody = document.getElementById('config-body');
    const configArrow = document.getElementById('config-arrow');
    if (configSectionOpen && configBody) { configBody.classList.add('open'); configArrow.classList.add('open'); }
    if (configToggle) configToggle.addEventListener('click', () => {
      configSectionOpen = !configSectionOpen;
      configBody.classList.toggle('open');
      configArrow.classList.toggle('open');
    });

    if (pauseBtn) pauseBtn.addEventListener('click', async () => { await ipcRenderer.invoke('pause-scheduler'); renderQueue(); });
    if (resumeBtn) resumeBtn.addEventListener('click', async () => { await ipcRenderer.invoke('resume-scheduler'); renderQueue(); });
    if (saveConfigBtn) saveConfigBtn.addEventListener('click', async () => {
      const start = parseInt(document.getElementById('wh-start').value) || 9;
      const end = parseInt(document.getElementById('wh-end').value) || 23;
      const budget = parseFloat(document.getElementById('budget-input').value) || 2;
      const blacklistStr = document.getElementById('blacklist-input').value || '';
      const blacklist = blacklistStr.split(',').map(s => s.trim()).filter(Boolean);
      const idleEnabled = document.getElementById('idle-enabled').checked;
      const idleMinutes = parseInt(document.getElementById('idle-minutes').value) || 15;
      const capacityEnabled = document.getElementById('capacity-enabled').checked;
      const capacityThreshold = parseInt(document.getElementById('capacity-threshold').value) || 50;
      await ipcRenderer.invoke('set-orchestrator-config', { workHours: { start, end }, dailyBudgetUsd: budget, blacklist, idleEnabled, idleMinutes, capacityEnabled, capacityThreshold });
      renderQueue();
    });
    if (addTaskBtn) addTaskBtn.addEventListener('click', () => showAddTaskDialog());

    panelContent.querySelectorAll('[data-remove]').forEach(el => {
      el.addEventListener('click', async () => {
        await ipcRenderer.invoke('remove-from-queue', el.dataset.remove);
        renderQueue();
      });
    });
  }

  async function showAddTaskDialog() {
    const projects = await ipcRenderer.invoke('get-project-analysis');
    const skills = await ipcRenderer.invoke('get-skills');
    const entries = Object.entries(projects).sort((a, b) => a[0].localeCompare(b[0]));

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'background:#1e1e2e;border:1px solid #2a2b3d;border-radius:8px;padding:14px;margin-bottom:10px;';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:12px;color:#c0caf5;font-weight:600;margin-bottom:8px;';
    title.textContent = 'Añadir tarea manual';
    wrapper.appendChild(title);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
    const selStyle = 'background:#181825;border:1px solid #2a2b3d;color:#c0caf5;border-radius:4px;padding:4px 8px;font-size:11px;';
    const projSel = document.createElement('select');
    projSel.id = 'add-project';
    projSel.style.cssText = selStyle;
    for (const [name] of entries) { const o = document.createElement('option'); o.value = name; o.textContent = name; projSel.appendChild(o); }
    row.appendChild(projSel);
    const skillSel = document.createElement('select');
    skillSel.id = 'add-skill';
    skillSel.style.cssText = selStyle;
    for (const s of skills) { const o = document.createElement('option'); o.value = s.name; o.textContent = s.name + ' ($' + s.budgetUsd + ')'; skillSel.appendChild(o); }
    row.appendChild(skillSel);
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'scan-btn';
    confirmBtn.textContent = 'Encolar';
    row.appendChild(confirmBtn);
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'scan-btn';
    cancelBtn.style.color = '#565f89';
    cancelBtn.textContent = 'Cancelar';
    row.appendChild(cancelBtn);
    wrapper.appendChild(row);

    panelContent.insertBefore(wrapper, panelContent.firstChild);

    confirmBtn.addEventListener('click', async () => {
      const projName = projSel.value;
      const skill = skillSel.value;
      const proj = projects[projName];
      if (proj && skill) {
        await ipcRenderer.invoke('add-to-queue', { project: projName, skill, projectPath: proj.path });
        renderQueue();
      }
    });
    cancelBtn.addEventListener('click', () => renderQueue());
  }

  return { renderQueue };
}

module.exports = { createQueueTab };
