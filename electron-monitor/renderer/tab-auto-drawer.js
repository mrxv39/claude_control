// renderer/tab-auto-drawer.js — Drawer de detalle de proyecto del tab
// Autónomo. Contiene preview README/CLAUDE.md, análisis Claude Haiku,
// sugerencia de plantilla y selector de objetivo. Extraído de tab-auto.js
// para que ese archivo no crezca más de ~600 líneas.

const { el } = require('./common.js');
const { stackColor, scoreColor } = require('./tab-auto-utils.js');

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

/**
 * Build a drawer opener bound to an IPC channel and a post-action callback.
 * The callback runs after the user applies an objective and the drawer closes.
 * @param {{ipcRenderer: any, onAfterAction: () => void}} deps
 * @returns {(name: string) => Promise<void>}
 */
function createDrawerOpener({ ipcRenderer, onAfterAction }) {
  return async function openProjectDrawer(name) {
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
          onAfterAction();
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
          onAfterAction();
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
  };
}

module.exports = { createDrawerOpener, TEMPLATE_DESCRIPTIONS, drawerSection, metaChip };
