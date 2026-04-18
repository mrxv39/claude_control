// renderer/tab-auto.js — Tab Autonomo: sistema nuevo F1+ (DOM-API only).
// Incluye project rows, feed, header, drawer de detalle de proyecto con
// preview README/CLAUDE.md, analisis via Claude Haiku, sugerencia de plantilla.
// Expuesto via createAutoTab({ipcRenderer}); attachEventStream(panelCore) cablea
// el stream auto:event que hace throttled refresh cuando este tab esta activo.

const { el } = require('./common.js');
const { stackColor, scoreColor, groupByStack, matchesSearch } = require('./tab-auto-utils.js');

const AUTO_TEMPLATES = [
  { name: 'production-ready', label: 'Production-ready' },
  { name: 'MVP-lanzable', label: 'MVP lanzable' },
  { name: 'mantenimiento', label: 'Mantenimiento' },
  { name: 'explorar-idea', label: 'Explorar idea' },
  { name: 'seguro-y-testeado', label: 'Seguro y testeado' },
];

const TEMPLATE_DESCRIPTIONS = {
  'production-ready': {
    label: 'Production-ready',
    tagline: 'Listo para usuarios reales',
    desc: 'Exige tests con cobertura ≥70% en módulos críticos, CLAUDE.md vigente, security audit <30d, score ≥8/10 y deps al día. Es el objetivo más estricto — elígelo para proyectos maduros que ya están (o estarán pronto) en producción.',
    color: '#9ece6a',
  },
  'MVP-lanzable': {
    label: 'MVP lanzable',
    tagline: 'Mínimo viable publicable',
    desc: 'README útil (qué hace, cómo arrancar), tests de happy path, sin bugs bloqueantes, script de deploy probado. Para proyectos en desarrollo activo que quieres poder enseñar/publicar en breve.',
    color: '#7aa2f7',
  },
  'mantenimiento': {
    label: 'Mantenimiento',
    tagline: 'No tocar demasiado',
    desc: 'Score ≥7/10 estable, deps revisadas cada 14d, sin commits rotos en main, CLAUDE.md coherente. Para proyectos que ya funcionan y solo quieres que no se pudran.',
    color: '#bb9af7',
  },
  'explorar-idea': {
    label: 'Explorar idea',
    tagline: 'Prototipo / research',
    desc: 'CLAUDE.md narrativo (idea, hipótesis), prototipos en ramas separadas, log de experimentos. Sin exigencias de cobertura ni deps al día. Para ideas tempranas donde la velocidad de experimentación importa más que la robustez.',
    color: '#e0af68',
  },
  'seguro-y-testeado': {
    label: 'Seguro y testeado',
    tagline: 'Robusto para uso externo',
    desc: 'Security audit mensual, 0 deps con CVEs activas, tests ≥80% en módulos de entrada (APIs, auth, pagos), secrets scanning, rate limiting documentado. Para proyectos con dominio sensible: pagos, datos personales, API pública.',
    color: '#f7768e',
  },
};

function createAutoTab({ ipcRenderer }) {
  const panelContent = document.getElementById('panel-content');
  let autoSearchQuery = '';
  let getCurrentTab = () => 'auto'; // default hasta que se llame attachEventStream

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

  async function openProjectDrawer(name) {
    const old = document.getElementById('auto-drawer');
    if (old) old.remove();

    const backdrop = el('div', {
      id: 'auto-drawer',
      style: {
        position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
        background: 'rgba(0,0,0,.5)', zIndex: '999',
        display: 'flex', justifyContent: 'flex-end',
      },
      onclick: (ev) => { if (ev.target.id === 'auto-drawer') backdrop.remove(); },
    });
    const drawer = el('div', {
      style: {
        width: 'min(640px, 85vw)', height: '100vh',
        background: '#1a1b26', borderLeft: '1px solid rgba(255,255,255,.08)',
        overflowY: 'auto', padding: '20px 24px',
        boxShadow: '-10px 0 40px rgba(0,0,0,.4)',
        color: '#c0caf5',
      },
    });

    drawer.appendChild(el('div', {
      style: { color: '#565f89', fontSize: '11px', marginBottom: '8px' },
      text: 'Cargando…',
    }));
    drawer.appendChild(el('h2', {
      style: { margin: '0 0 12px', fontSize: '20px', fontWeight: '600' },
      text: name,
    }));

    backdrop.appendChild(drawer);
    document.body.appendChild(backdrop);

    const [info, current, suggestion] = await Promise.all([
      ipcRenderer.invoke('auto:get-project-info', name),
      ipcRenderer.invoke('auto:get-project', name),
      ipcRenderer.invoke('auto:suggest-goal', name),
    ]);

    drawer.replaceChildren();

    const headerRow = el('div', {
      style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '4px' },
    },
    el('div', {},
      el('h2', { style: { margin: '0', fontSize: '22px', fontWeight: '600' }, text: name }),
      el('div', { style: { color: '#565f89', fontSize: '11px', marginTop: '4px' }, text: info.path || '—' }),
    ),
    el('button', {
      style: { background: 'transparent', border: 'none', color: '#565f89', fontSize: '20px', cursor: 'pointer', padding: '0 4px' },
      title: 'Cerrar',
      text: '✕',
      onclick: () => backdrop.remove(),
    }));
    drawer.appendChild(headerRow);

    const chips = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '12px 0 14px' } });
    if (info.stack) chips.appendChild(metaChip(info.stack, stackColor(info.stack)));
    if (typeof info.score === 'number') chips.appendChild(metaChip(`Score ${info.score}/10`, scoreColor(info.score)));
    if (typeof info.lastCommitDays === 'number') {
      const d = info.lastCommitDays;
      const lbl = d === 0 ? 'Commit hoy' : d === 1 ? 'Commit ayer' : `Último commit: hace ${d}d`;
      chips.appendChild(metaChip(lbl, d <= 7 ? '#9ece6a' : d <= 30 ? '#e0af68' : '#565f89'));
    }
    if (typeof info.recentCommits === 'number' && info.recentCommits > 0) {
      chips.appendChild(metaChip(`${info.recentCommits} commits /14d`, '#7aa2f7'));
    }
    drawer.appendChild(chips);

    const haystack = ((info.readme || '') + ' ' + (info.claudeMd || '')).toLowerCase();
    const scratchpadSignals = ['scratchpad', 'workspace para tareas', 'sin código de aplicación', 'sin aplicación', 'repositorio de notas', 'solo documentación'];
    const isScratchpad = scratchpadSignals.some(s => haystack.includes(s));
    if (isScratchpad) {
      drawer.appendChild(el('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '10px 14px', marginBottom: '14px',
          background: 'rgba(224,175,104,.08)',
          border: '1px solid rgba(224,175,104,.3)',
          borderRadius: '6px',
        },
      },
      el('span', { style: { fontSize: '16px' }, text: '🗒' }),
      el('div', {},
        el('div', { style: { color: '#e0af68', fontSize: '12px', fontWeight: '600' }, text: 'Workspace / notas' }),
        el('div', { style: { color: '#a9b1d6', fontSize: '11px', marginTop: '2px' }, text: 'Este repo parece documentación/notas sin código. Probablemente no merece plantilla — considera dejarlo pausado.' }),
      )));
    }

    const askCard = el('div', {
      id: 'auto-drawer-ask',
      style: {
        padding: '14px 16px', marginBottom: '18px',
        background: 'linear-gradient(135deg, rgba(187,154,247,.08), rgba(122,162,247,.06))',
        border: '1px solid rgba(187,154,247,.25)',
        borderRadius: '8px',
      },
    });
    const askTitle = el('div', {
      style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' },
    },
    el('span', { style: { fontSize: '15px' }, text: '🤖' }),
    el('span', { style: { color: '#bb9af7', fontSize: '13px', fontWeight: '600' }, text: '¿Qué es este proyecto?' }));
    askCard.appendChild(askTitle);
    askCard.appendChild(el('div', {
      style: { color: '#a9b1d6', fontSize: '11px', marginBottom: '10px', lineHeight: '1.5' },
      text: 'Claude Haiku leerá README + CLAUDE.md + package.json + últimos commits + archivos en raíz, y te resumirá en 3-4 frases qué hace, en qué estado está, y si vale la pena activarlo. ~1-2k tokens.',
    }));
    const askBtn = el('button', {
      class: 'scan-btn',
      style: { fontSize: '11px', color: '#bb9af7', borderColor: 'rgba(187,154,247,.4)', background: 'rgba(187,154,247,.15)' },
      text: '💭 Analizar con Claude',
      onclick: async () => {
        askBtn.disabled = true;
        askBtn.textContent = 'Analizando…';
        const out = await ipcRenderer.invoke('auto:analyze-project', name);
        askBtn.remove();
        const resultBox = el('div', {
          style: {
            padding: '12px 14px', marginTop: '4px',
            background: 'rgba(0,0,0,.2)',
            borderLeft: '3px solid #bb9af7',
            borderRadius: '4px',
            fontSize: '12px', lineHeight: '1.6', color: '#c0caf5',
            whiteSpace: 'pre-wrap',
          },
          text: out.error ? `Error: ${out.error}` : (out.summary || 'Sin respuesta'),
        });
        askCard.appendChild(resultBox);
      },
    });
    askCard.appendChild(askBtn);
    drawer.appendChild(askCard);

    if (info.readme) {
      drawer.appendChild(drawerSection('README',
        el('div', {
          style: {
            fontSize: '12px', lineHeight: '1.5', whiteSpace: 'pre-wrap',
            color: '#a9b1d6', maxHeight: '180px', overflowY: 'auto',
            background: 'rgba(0,0,0,.2)', padding: '10px 12px', borderRadius: '4px',
            border: '1px solid rgba(255,255,255,.04)', fontFamily: 'inherit',
          },
          text: info.readme.length >= 2000 ? info.readme + '\n\n…[truncado]' : info.readme,
        })
      ));
    }

    if (info.claudeMd) {
      drawer.appendChild(drawerSection('CLAUDE.md',
        el('div', {
          style: {
            fontSize: '12px', lineHeight: '1.5', whiteSpace: 'pre-wrap',
            color: '#a9b1d6', maxHeight: '150px', overflowY: 'auto',
            background: 'rgba(0,0,0,.2)', padding: '10px 12px', borderRadius: '4px',
            border: '1px solid rgba(255,255,255,.04)', fontFamily: 'inherit',
          },
          text: info.claudeMd.length >= 2000 ? info.claudeMd + '\n\n…[truncado]' : info.claudeMd,
        })
      ));
    } else {
      drawer.appendChild(drawerSection('CLAUDE.md',
        el('div', {
          style: { fontSize: '11px', color: '#565f89', fontStyle: 'italic', padding: '8px 12px' },
          text: 'No tiene CLAUDE.md. Una de las primeras tareas autónomas lo creará.',
        })
      ));
    }

    if (info.recentCommitsList && info.recentCommitsList.length) {
      const commitsBox = el('div', {
        style: {
          fontSize: '11px', fontFamily: "'JetBrains Mono', Consolas, monospace", lineHeight: '1.5',
          color: '#a9b1d6', background: 'rgba(0,0,0,.2)',
          padding: '10px 12px', borderRadius: '4px',
          border: '1px solid rgba(255,255,255,.04)',
        },
      });
      for (const c of info.recentCommitsList) {
        commitsBox.appendChild(el('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: c }));
      }
      drawer.appendChild(drawerSection('Últimos commits', commitsBox));
    }

    if (suggestion && suggestion.template) {
      const tplDef = TEMPLATE_DESCRIPTIONS[suggestion.template] || { label: suggestion.template, color: '#7aa2f7', desc: '' };
      const conf = Math.round((suggestion.confidence || 0) * 100);
      const suggestionCard = el('div', {
        style: {
          padding: '14px 16px', margin: '16px 0',
          background: tplDef.color + '10',
          border: `1px solid ${tplDef.color}40`,
          borderRadius: '6px',
        },
      },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
        el('span', { style: { fontSize: '14px' }, text: '💡' }),
        el('span', { style: { color: '#565f89', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.5px' }, text: 'Sugerencia' }),
        el('span', { style: { color: tplDef.color, fontSize: '13px', fontWeight: '600' }, text: tplDef.label }),
        el('span', { style: { color: '#565f89', fontSize: '10px', marginLeft: 'auto' }, text: `${conf}% confianza` }),
      ),
      el('div', { style: { color: '#a9b1d6', fontSize: '12px', lineHeight: '1.5', marginBottom: '10px' }, text: suggestion.reasoning || '' }),
      el('button', {
        class: 'scan-btn',
        style: { fontSize: '11px', color: tplDef.color, borderColor: tplDef.color + '60', background: tplDef.color + '20' },
        text: `Aplicar "${tplDef.label}"`,
        onclick: async () => {
          await ipcRenderer.invoke('auto:set-objective', name, { template: suggestion.template });
          backdrop.remove();
          renderAuto();
        },
      }));
      drawer.appendChild(suggestionCard);
    }

    const currentTpl = current?.objective?.template || '';
    drawer.appendChild(el('div', {
      style: { color: '#565f89', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.5px', margin: '20px 0 8px' },
      text: 'Elegir objetivo',
    }));
    for (const [key, def] of Object.entries(TEMPLATE_DESCRIPTIONS)) {
      const isActive = currentTpl === key;
      const card = el('div', {
        style: {
          padding: '12px 14px', marginBottom: '8px',
          background: isActive ? def.color + '1a' : 'rgba(255,255,255,.02)',
          border: `1px solid ${isActive ? def.color + '60' : 'rgba(255,255,255,.06)'}`,
          borderRadius: '6px', cursor: 'pointer',
          transition: 'background 120ms, border-color 120ms',
        },
        onclick: async () => {
          if (isActive) {
            await ipcRenderer.invoke('auto:set-objective', name, null);
          } else {
            await ipcRenderer.invoke('auto:set-objective', name, { template: key });
          }
          backdrop.remove();
          renderAuto();
        },
      });
      card.addEventListener('mouseenter', () => {
        if (!isActive) card.style.background = 'rgba(255,255,255,.04)';
      });
      card.addEventListener('mouseleave', () => {
        if (!isActive) card.style.background = 'rgba(255,255,255,.02)';
      });
      const header = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } },
        el('span', { style: { color: def.color, fontSize: '13px', fontWeight: '600' }, text: def.label }),
        el('span', { style: { color: '#565f89', fontSize: '11px' }, text: `— ${def.tagline}` }),
      );
      if (isActive) header.appendChild(el('span', {
        style: { marginLeft: 'auto', color: def.color, fontSize: '10px', textTransform: 'uppercase' },
        text: '✓ activo',
      }));
      card.appendChild(header);
      card.appendChild(el('div', { style: { color: '#a9b1d6', fontSize: '11px', lineHeight: '1.5' }, text: def.desc }));
      drawer.appendChild(card);
    }
  }

  function drawerSection(title, content) {
    const wrap = el('div', { style: { marginTop: '16px' } });
    wrap.appendChild(el('div', {
      style: { color: '#565f89', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: '6px' },
      text: title,
    }));
    wrap.appendChild(content);
    return wrap;
  }

  function metaChip(text, color) {
    return el('span', {
      style: {
        color, background: color + '1a',
        padding: '3px 8px', borderRadius: '4px', fontSize: '11px',
        border: `1px solid ${color}30`,
      },
      text,
    });
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
