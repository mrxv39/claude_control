// renderer/bar.js — Barra principal: chips de sesiones, indicadores idle/AVG, update-chip.
// Encapsula estado local (selected, gitCache) y el polling de sesiones.

const { esc, rateColor } = require('./common.js');

const GIT_CACHE_TTL = 30000; // 30s entre git status refreshes por cwd

function initBar({ ipcRenderer, isPanel }) {
  const chips = document.getElementById('chips');
  const stats = document.getElementById('stats');
  const selected = new Set(); // hwnd values
  const gitCache = {};        // cwd -> { branch, dirty, recentCommits }
  const gitCacheTime = {};    // cwd -> timestamp of last fetch

  function render(sessions) {
    chips.innerHTML = '';
    if (!sessions.length) {
      chips.innerHTML = '<span class="run">No sessions</span>';
      stats.textContent = '';
      return;
    }

    const groups = new Map();
    for (const s of sessions) {
      const key = (s.cwd && s.cwd !== 'N/A') ? s.cwd.toLowerCase() : `_pid_${s.pid}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    const order = { BUSY: 0, WAITING: 1, IDLE: 2 };
    const items = [];
    for (const [, group] of groups) {
      const claude = group.filter(s => s.isClaude);
      const nonClaude = group.filter(s => !s.isClaude);
      let primary;
      if (claude.length > 0) {
        claude.sort((a, b) => (order[a.status] || 2) - (order[b.status] || 2));
        primary = claude[0];
      } else {
        primary = group[0];
      }
      const primaryHwnd = primary.hwnd || 0;
      const services = nonClaude.map(s => ({
        label: (s.running && s.running !== '-') ? s.running : (s.shell || '?'),
        hwnd: s.hwnd || primaryHwnd,
        tabIndex: s.tabIndex,
      })).filter(sv => sv.label);
      items.push({ ...primary, services });
    }
    items.sort((a, b) => (order[a.status] || 2) - (order[b.status] || 2));

    const live = new Set(items.map(s => s.hwnd).filter(Boolean));
    for (const h of [...selected]) if (!live.has(h)) selected.delete(h);

    let b = 0, w = 0, i = 0;
    items.forEach(s => {
      if (s.status === 'BUSY') b++; else if (s.status === 'WAITING') w++; else i++;
      const d = document.createElement('div');
      d.className = 'chip ' + s.status.toLowerCase();
      d.setAttribute('tabindex', '0');
      d.setAttribute('role', 'button');
      if (s.hwnd && selected.has(s.hwnd)) d.classList.add('selected');
      const ctx = s.contextPercent || 0;
      d.title = `${s.project}\n${s.cwd || ''}\nEstado: ${s.status}\nContexto: ${ctx}%\nPID: ${s.pid}`;
      const run = s.running !== '-' ? ` <span class="run">[${esc(s.running)}]</span>` : '';

      const mainDiv = document.createElement('div');
      mainDiv.className = 'chip-main';
      // innerHTML seguro: valores dinámicos pasan por esc() (HTML entity escaping). App local sin contenido remoto.
      mainDiv.innerHTML = `<span class="dot"></span><span class="name">${esc(s.project)}</span>${run}`;
      d.appendChild(mainDiv);

      if (s.services.length) {
        const svcDiv = document.createElement('div');
        svcDiv.className = 'chip-svc';
        s.services.forEach(sv => {
          const badge = document.createElement('span');
          badge.className = 'svc';
          badge.textContent = '\u2699 ' + sv.label;
          badge.addEventListener('click', (ev) => {
            ev.stopPropagation();
            selected.clear();
            ipcRenderer.invoke('focus-wt', { hwnd: sv.hwnd, tabIndex: sv.tabIndex });
            try { ipcRenderer.invoke('track', 'session_focus', {}); } catch {}
            refresh();
          });
          svcDiv.appendChild(badge);
        });
        d.appendChild(svcDiv);
      }

      d.addEventListener('click', (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && s.hwnd) {
          if (selected.has(s.hwnd)) selected.delete(s.hwnd);
          else selected.add(s.hwnd);
          if (selected.size >= 2) {
            ipcRenderer.invoke('tile-windows', [...selected]);
          }
          refresh();
          return;
        }
        selected.clear();
        ipcRenderer.invoke('focus-wt', { hwnd: s.hwnd, tabIndex: s.tabIndex });
        try { ipcRenderer.invoke('track', 'session_focus', {}); } catch {}
        refresh();
      });
      d.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          d.click();
        }
      });
      chips.appendChild(d);
    });

    const total = sessions.length;
    stats.textContent = `${total}T ${b}● ${w}◉ ${i}○` + (selected.size ? ` · ${selected.size} sel` : '');

    clearTimeout(render._resizeTimer);
    render._resizeTimer = setTimeout(() => {
      const bar = document.querySelector('.bar');
      if (bar) {
        const width = bar.scrollWidth + 4;
        if (width !== render._lastWidth) {
          render._lastWidth = width;
          ipcRenderer.invoke('resize-bar', width);
        }
      }
    }, 100);
  }

  async function refresh() {
    const sessions = await ipcRenderer.invoke('get-sessions');
    const now = Date.now();
    const cwds = new Set(sessions.filter(s => s.cwd && s.cwd !== 'N/A').map(s => s.cwd));
    for (const cwd of cwds) {
      if (!gitCache[cwd]) gitCache[cwd] = { branch: null, dirty: 0, recentCommits: [] };
      if (!gitCacheTime[cwd] || now - gitCacheTime[cwd] > GIT_CACHE_TTL) {
        gitCacheTime[cwd] = now;
        ipcRenderer.invoke('get-git-status', cwd).then(git => {
          if (git) gitCache[cwd] = git;
        }).catch(() => {});
      }
    }
    render(sessions);

    try {
      const sched = await ipcRenderer.invoke('get-scheduler-status');
      const ind = document.getElementById('idle-indicator');
      if (sched.rateLimits) {
        const pct = Math.round(sched.rateLimits.fiveHour.usedPercent);
        const p = sched.pacingDecision;
        const color = rateColor(pct);
        let label = `5h:${pct}%`;
        if (p && p.targetUsage !== undefined) label += `→${Math.round(p.targetUsage)}%`;
        if (p && p.action === 'burst') label += ' BURST';
        else if (p && p.action === 'coast') label += ' coast';
        if (sched.running) {
          const modeTag = { 'off-hours': 'AUTO', 'idle': 'IDLE', 'capacity': 'CAP' }[sched.currentMode] || 'AUTO';
          label += ' ' + modeTag;
        }
        ind.textContent = label;
        ind.style.display = '';
        ind.style.color = color;
        ind.style.background = color + '22';
      } else if (sched.running) {
        const modeLabels = { 'off-hours': 'AUTO', 'idle': 'AUTO-IDLE', 'capacity': 'AUTO-CAP' };
        ind.textContent = modeLabels[sched.currentMode] || 'AUTO';
        ind.style.display = '';
        ind.style.color = '#bb9af7';
        ind.style.background = 'rgba(187,154,247,.15)';
      } else if (sched.userIsIdle && sched.idleEnabled && !sched.paused) {
        ind.textContent = `idle ${sched.userIdleFor}m`;
        ind.style.display = '';
        ind.style.color = '#565f89';
        ind.style.background = 'rgba(255,255,255,.05)';
      } else {
        ind.style.display = 'none';
      }
    } catch {}

    try {
      const avg = await ipcRenderer.invoke('auto:token-avg', 7);
      const avgEl = document.getElementById('avg-indicator');
      if (!avgEl) return;
      if (!avg || avg.status === 'no-data' || avg.count === 0) {
        avgEl.style.display = 'none';
        return;
      }
      const pct = avg.avg;
      const color = pct >= 90 ? '#9ece6a' : pct >= 70 ? '#e0af68' : '#f7768e';
      avgEl.textContent = `AVG ${pct}%`;
      avgEl.style.color = color;
      avgEl.style.background = color + '22';
      avgEl.style.display = '';
    } catch {}
  }

  if (!isPanel) {
    refresh();
    setInterval(refresh, 3000);
  }

  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'avg-indicator') {
      ipcRenderer.invoke('toggle-panel');
    }
  });

  ipcRenderer.on('update-available', (ev, version, url) => {
    let upd = document.getElementById('update-chip');
    if (upd) return;
    upd = document.createElement('div');
    upd.id = 'update-chip';
    upd.className = 'chip update';
    const mainDiv = document.createElement('div');
    mainDiv.className = 'chip-main';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.style.color = '#e0af68';
    nameSpan.textContent = 'Update ' + version;
    mainDiv.appendChild(nameSpan);
    upd.appendChild(mainDiv);
    upd.title = 'Click para descargar la nueva version';
    upd.addEventListener('click', () => {
      if (url && url.startsWith('https://github.com/')) require('electron').shell.openExternal(url);
    });
    document.querySelector('.chips').prepend(upd);
  });

  return { refresh };
}

module.exports = { initBar };
