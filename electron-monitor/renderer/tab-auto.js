// renderer/tab-auto.js — Tab Autonomo: sistema nuevo F1+ (DOM-API only).
// Project rows, feed, header. El drawer de detalle está en tab-auto-drawer.js.
// Expuesto via createAutoTab({ipcRenderer}); attachEventStream(panelCore) cablea
// el stream auto:event que hace throttled refresh cuando este tab esta activo.

const { el } = require('./common.js');
const { stackColor, scoreColor, groupByStack, matchesSearch } = require('./tab-auto-utils.js');
const { createDrawerOpener } = require('./tab-auto-drawer.js');

const AUTO_TEMPLATES = [
  { name: 'production-ready', label: 'Production-ready' },
  { name: 'MVP-lanzable', label: 'MVP lanzable' },
  { name: 'mantenimiento', label: 'Mantenimiento' },
  { name: 'explorar-idea', label: 'Explorar idea' },
  { name: 'seguro-y-testeado', label: 'Seguro y testeado' },
];

function createAutoTab({ ipcRenderer }) {
  const panelContent = document.getElementById('panel-content');
  let autoSearchQuery = '';
  let getCurrentTab = () => 'auto'; // default hasta que se llame attachEventStream
  const openProjectDrawer = createDrawerOpener({
    ipcRenderer,
    onAfterAction: () => { renderAuto().catch(() => {}); },
  });

  function autoProjectRow(name, p, active) {
    const tpl = p.objective?.template || '';
    const score = p.analysis?.score ?? p.score ?? null;
    const stack = p.stack || 'unknown';
    const sColor = stackColor(stack);
    const scColor = score != null ? scoreColor(score) : '#565f89';

    const row = el('div', {
      class: 'auto-row' + (active ? ' auto-row-active' : ''),
      dataset: { project: name },
    });

    const toggle = el('button', {
      class: 'auto-toggle' + (active ? ' on' : ''),
      title: active ? 'Pausar este proyecto' : 'Activar este proyecto',
      onclick: async (ev) => {
        ev.stopPropagation();
        await ipcRenderer.invoke('auto:toggle-active', name, !active);
        renderAuto();
      },
    });
    toggle.appendChild(el('span', { class: 'auto-toggle-knob' }));

    const labelCol = el('div', { class: 'auto-label-col' });
    const nameBtn = el('span', {
      class: 'auto-name',
      title: 'Ver detalle del proyecto',
      text: name,
      onclick: () => openProjectDrawer(name),
    });
    labelCol.appendChild(nameBtn);
    labelCol.appendChild(el('span', {
      class: 'auto-stack-badge',
      style: { color: sColor, background: sColor + '1a' },
      text: stack,
    }));

    const select = el('select', {
      class: 'auto-template' + (tpl ? ' has-tpl' : ''),
      onchange: async () => {
        const val = select.value;
        await ipcRenderer.invoke('auto:set-objective', name, val ? { template: val } : null);
        renderAuto();
      },
    });
    select.appendChild(el('option', { value: '', text: '— sin objetivo —' }));
    for (const t of AUTO_TEMPLATES) {
      const opt = el('option', { value: t.name, text: t.label });
      if (tpl === t.name) opt.selected = true;
      select.appendChild(opt);
    }

    const scorePill = el('span', {
      class: 'auto-score-pill',
      style: { color: scColor, background: scColor + '1a' },
      text: score != null ? `${score}/10` : '—',
    });

    row.append(toggle, labelCol, select, scorePill);
    return row;
  }

  function autoEventNode(e) {
    const t = new Date(e.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let color = '#c0caf5';
    let icon = '·';
    if (e.type === 'skill-executed') { color = e.outcome === 'ok' ? '#9ece6a' : '#f7768e'; icon = e.outcome === 'ok' ? '✓' : '✗'; }
    else if (e.type === 'goal-reached') { color = '#9ece6a'; icon = '★'; }
    else if (e.type === 'goal-regressed') { color = '#e0af68'; icon = '↓'; }
    else if (e.type === 'circuit-breaker-trip') { color = '#f7768e'; icon = '⛔'; }
    else if (e.type === 'planner-decision') { color = '#7aa2f7'; icon = '→'; }
    else if (e.type === 'dry-run') { color = '#e0af68'; icon = '◐'; }
    else if (e.type === 'tick-skip') { color = '#565f89'; icon = '·'; }
    else if (e.type === 'tick-error' || e.type === 'analyze-error') { color = '#f7768e'; icon = '!'; }

    const detail = e.project ? `${e.project} ${e.skill || ''}`.trim() : (e.reason || e.reasoning || '');
    return el('div', { style: { color }, text: `${t} ${icon} ${e.type} ${detail}` });
  }

  function sectionHeader(title, count, color) {
    return el('div', {
      class: 'auto-section-header',
      style: color ? { color } : {},
    },
    el('span', { text: title }),
    el('span', { class: 'auto-section-count', text: `· ${count}` }));
  }

  async function renderAuto() {
    const cfg = await ipcRenderer.invoke('auto:get-config');
    const status = await ipcRenderer.invoke('auto:get-status');
    const events = await ipcRenderer.invoke('auto:get-events', 50);
    const projects = Object.entries(cfg.projects || {});
    const filtered = projects.filter(([n, p]) => matchesSearch(n, p, autoSearchQuery));
    const active = filtered.filter(([, p]) => p.active);
    const paused = filtered.filter(([, p]) => !p.active);

    panelContent.replaceChildren();

    const headerCard = el('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap',
        padding: '14px 16px', marginBottom: '6px',
        background: 'rgba(255,255,255,.02)',
        borderBottom: '1px solid rgba(255,255,255,.06)',
      },
    });

    const dryColor = status.dryRun ? '#e0af68' : '#9ece6a';
    const statusIcon = el('div', {
      style: {
        width: '8px', height: '8px', borderRadius: '50%',
        background: dryColor, boxShadow: `0 0 8px ${dryColor}`,
        flexShrink: '0',
      },
    });
    const statusText = el('div', {}, el('div', {
      style: { color: dryColor, fontSize: '13px', fontWeight: '600', letterSpacing: '.5px' },
      text: status.dryRun ? 'DRY-RUN' : 'EJECUCIÓN REAL',
    }), el('div', {
      style: { color: '#565f89', fontSize: '10px' },
      text: status.dryRun ? 'Decide pero no ejecuta' : 'Ejecuta skills reales',
    }));
    headerCard.append(statusIcon, statusText);

    const counter = el('div', { style: { marginLeft: '8px', paddingLeft: '14px', borderLeft: '1px solid rgba(255,255,255,.1)' } },
      el('div', { style: { color: '#c0caf5', fontSize: '15px', fontWeight: '600', fontVariantNumeric: 'tabular-nums' }, text: `${projects.filter(p => p[1].active).length} / ${projects.length}` }),
      el('div', { style: { color: '#565f89', fontSize: '10px' }, text: 'proyectos activos' }),
    );
    headerCard.appendChild(counter);

    const search = el('input', {
      type: 'text',
      placeholder: 'Buscar por nombre o stack…',
      value: autoSearchQuery,
      style: {
        marginLeft: 'auto', flex: '0 1 220px',
        padding: '6px 10px', fontSize: '12px',
        background: 'rgba(255,255,255,.04)',
        border: '1px solid rgba(255,255,255,.1)',
        borderRadius: '4px', color: '#c0caf5',
        outline: 'none',
      },
      oninput: (ev) => { autoSearchQuery = ev.target.value; renderAuto(); },
    });
    headerCard.appendChild(search);

    const dryBtn = el('button', {
      class: 'scan-btn',
      style: {
        fontSize: '11px', padding: '6px 10px',
        background: status.dryRun ? 'rgba(158,206,106,.12)' : 'rgba(247,118,142,.12)',
        borderColor: status.dryRun ? 'rgba(158,206,106,.3)' : 'rgba(247,118,142,.3)',
        color: status.dryRun ? '#9ece6a' : '#f7768e',
      },
      text: status.dryRun ? '▶ Activar ejecución' : '◼ Volver a dry-run',
      onclick: async () => {
        await ipcRenderer.invoke('auto:set-dry-run', !status.dryRun);
        renderAuto();
      },
    });
    const tickBtn = el('button', {
      class: 'scan-btn',
      style: { fontSize: '11px', padding: '6px 10px' },
      text: '⚡ Tick ahora',
      onclick: async () => {
        tickBtn.disabled = true;
        tickBtn.textContent = 'Ejecutando…';
        await ipcRenderer.invoke('auto:tick-now');
        setTimeout(() => renderAuto(), 500);
      },
    });
    headerCard.append(dryBtn, tickBtn);
    panelContent.appendChild(headerCard);

    if (autoSearchQuery) setTimeout(() => { search.focus(); search.setSelectionRange(autoSearchQuery.length, autoSearchQuery.length); }, 0);

    panelContent.appendChild(sectionHeader('Activos', active.length, '#9ece6a'));
    if (!active.length) {
      panelContent.appendChild(el('div', {
        style: {
          padding: '16px', margin: '4px 12px',
          color: '#565f89', fontSize: '12px', fontStyle: 'italic',
          textAlign: 'center',
          background: 'rgba(255,255,255,.02)',
          border: '1px dashed rgba(255,255,255,.08)',
          borderRadius: '6px',
        },
        text: autoSearchQuery
          ? 'Sin coincidencias activas. Limpia el buscador o activa alguno abajo.'
          : 'Aún no has activado ningún proyecto. Activa uno abajo con el toggle para empezar.',
      }));
    } else {
      for (const [name, p] of active) panelContent.appendChild(autoProjectRow(name, p, true));
    }

    panelContent.appendChild(sectionHeader('Pausados', paused.length, '#565f89'));
    if (!paused.length) {
      panelContent.appendChild(el('div', {
        style: { padding: '12px', margin: '4px 12px', color: '#565f89', fontSize: '11px', textAlign: 'center' },
        text: autoSearchQuery ? 'Sin coincidencias pausadas.' : 'Todos los proyectos están activos.',
      }));
    } else {
      const groups = groupByStack(paused);
      for (const g of groups) {
        panelContent.appendChild(el('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '8px 12px 4px', fontSize: '10px',
            color: stackColor(g.stack), textTransform: 'uppercase', letterSpacing: '.3px', fontWeight: '600',
          },
        },
        el('span', { text: g.stack }),
        el('span', { style: { color: '#565f89', fontWeight: '400' }, text: `· ${g.projects.length}` })));
        for (const [name, p] of g.projects) panelContent.appendChild(autoProjectRow(name, p, false));
      }
    }

    panelContent.appendChild(sectionHeader('Feed', events.length, '#7aa2f7'));
    if (!events.length) {
      panelContent.appendChild(el('div', {
        style: { padding: '12px', margin: '4px 12px', color: '#565f89', fontSize: '11px', textAlign: 'center', fontStyle: 'italic' },
        text: 'Sin eventos aún. El orquestador emite en cada tick.',
      }));
    } else {
      const feedBox = el('div', {
        style: {
          fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: '10px', lineHeight: '1.6',
          padding: '8px 12px',
          background: 'rgba(0,0,0,.15)',
          margin: '4px 12px 12px',
          borderRadius: '4px',
          border: '1px solid rgba(255,255,255,.04)',
          maxHeight: '260px', overflowY: 'auto',
        },
      });
      for (const e of events.slice(-30).reverse()) feedBox.appendChild(autoEventNode(e));
      panelContent.appendChild(feedBox);
    }
  }

  function attachEventStream(panelCore) {
    getCurrentTab = () => panelCore.getCurrentTab();
    let refreshTimer = null;
    ipcRenderer.on('auto:event', () => {
      if (getCurrentTab() !== 'auto') return;
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        renderAuto().catch(() => {});
      }, 1000);
    });
  }

  return { renderAuto, attachEventStream };
}

module.exports = { createAutoTab };
