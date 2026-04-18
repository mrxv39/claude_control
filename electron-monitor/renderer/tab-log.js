// renderer/tab-log.js — Tab Log: muestra log de conversacion Claude de una sesion
// seleccionada + historial de ejecuciones autonomas del orquestador.
// innerHTML usos: valores dinamicos pasan por esc() (HTML entity escaping). App local Electron sin contenido remoto.

const { esc } = require('./common.js');

function createLogTab({ ipcRenderer }) {
  const panelContent = document.getElementById('panel-content');
  let selectedSessionCwd = null;

  async function renderLog() {
    let html = '';
    html += '<div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;">';
    html += '<span style="font-size:11px;color:#565f89;">Sesión:</span>';
    html += '<select id="log-session-select" style="background:#1e1e2e;border:1px solid #2a2b3d;color:#c0caf5;border-radius:4px;padding:4px 8px;font-size:11px;flex:1;">';
    html += '<option value="">— Seleccionar sesión —</option>';

    try {
      const sessions = await ipcRenderer.invoke('get-sessions');
      const seen = new Set();
      for (const s of sessions) {
        if (s.cwd && s.cwd !== 'N/A' && !seen.has(s.cwd)) {
          seen.add(s.cwd);
          const sel = s.cwd === selectedSessionCwd ? ' selected' : '';
          html += `<option value="${esc(s.cwd)}"${sel}>${esc(s.project || s.cwd)}</option>`;
        }
      }
    } catch {}

    html += '</select>';
    html += '<button class="scan-btn" id="show-exec-log" style="font-size:10px;padding:2px 8px;">Historial auto</button>';
    html += '</div>';

    if (selectedSessionCwd) {
      let entries = [];
      try { entries = await ipcRenderer.invoke('get-session-log', selectedSessionCwd); } catch {}
      if (!entries.length) {
        html += '<div class="empty-msg">No hay datos de conversación para esta sesión.</div>';
      } else {
        for (const entry of entries) {
          const typeColor = entry.type === 'user' ? '#7aa2f7' :
                            entry.type === 'assistant' ? '#9ece6a' : '#565f89';
          const typeLabel = entry.type === 'user' ? 'USER' :
                            entry.type === 'assistant' ? 'CLAUDE' : 'TOOL';
          html += `<div class="queue-item" style="align-items:flex-start;">`;
          html += `<span class="queue-status" style="background:${typeColor}22;color:${typeColor};min-width:50px;text-align:center;">${typeLabel}</span>`;
          html += `<span class="queue-info" style="font-size:11px;word-break:break-word;">${esc(entry.summary || '...')}</span>`;
          html += `</div>`;
        }
      }
    } else {
      html += '<div class="empty-msg">Selecciona una sesión activa para ver su log de conversación.</div>';
    }

    panelContent.innerHTML = html;

    const sel = document.getElementById('log-session-select');
    if (sel) sel.addEventListener('change', (e) => {
      selectedSessionCwd = e.target.value || null;
      renderLog();
    });
    const execBtn = document.getElementById('show-exec-log');
    if (execBtn) execBtn.addEventListener('click', () => renderExecLog());
  }

  async function renderExecLog() {
    const log = await ipcRenderer.invoke('get-execution-log');
    if (!log.length) {
      panelContent.innerHTML = '<div class="empty-msg">No hay ejecuciones autónomas registradas.</div>';
      return;
    }
    let html = '<div style="font-size:12px;color:#c0caf5;font-weight:600;margin-bottom:8px;">Historial de ejecuciones autónomas</div>';
    for (const entry of log.reverse()) {
      const statusClass = entry.status === 'done' ? 'queue-done' : 'queue-failed';
      const time = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '?';
      html += `<div class="queue-item">`;
      html += `<span class="queue-status ${statusClass}">${esc(entry.status || '?')}</span>`;
      html += `<span class="queue-info">${esc(entry.project || '?')} — ${esc(entry.skill || '?')}`;
      if (entry.branch) html += ` <span style="color:#bb9af7;font-size:10px;">${esc(entry.branch)}</span>`;
      html += `</span>`;
      if (entry.costUsd) html += `<span class="queue-cost">$${entry.costUsd.toFixed(3)}</span>`;
      html += `<span class="queue-cost">${esc(time)}</span>`;
      html += `</div>`;
    }
    html += '<button class="scan-btn" style="margin-top:8px;" id="exec-back-btn">Volver</button>';
    panelContent.innerHTML = html;
    const backBtn = document.getElementById('exec-back-btn');
    if (backBtn) backBtn.addEventListener('click', () => renderLog());
  }

  return { renderLog };
}

module.exports = { createLogTab };
