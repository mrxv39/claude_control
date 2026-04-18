// renderer/panel-core.js — Coordinacion del panel: togglePanel, minimize-all,
// tab switching y loadTab. Los renderers de cada tab se pasan por parametro.

function initPanelCore({ ipcRenderer, isPanel, tabRenderers }) {
  const gearBtn = document.getElementById('gear-btn');
  const panelCloseBtn = document.getElementById('panel-close-btn');
  const closeBtn = document.getElementById('close-btn');
  const minBtn = document.getElementById('minimize-all-btn');
  const budgetDisplay = document.getElementById('budget-display');
  let currentTab = 'health';
  let minimizedHwnds = [];

  async function togglePanel() {
    if (isPanel) {
      await ipcRenderer.invoke('toggle-panel');
      return;
    }
    const isOpen = await ipcRenderer.invoke('toggle-panel');
    if (gearBtn) gearBtn.classList.toggle('active', isOpen);
    try { ipcRenderer.invoke('track', 'panel_toggle', { open: !!isOpen }); } catch {}
  }

  async function loadTab(tab) {
    try {
      const budget = await ipcRenderer.invoke('get-budget-status');
      if (budgetDisplay) {
        budgetDisplay.textContent = `$${budget.todaySpent.toFixed(2)} / $${budget.dailyBudget.toFixed(2)}`;
      }
    } catch {}
    const renderer = tabRenderers[tab];
    if (renderer) await renderer();
  }

  if (gearBtn) gearBtn.addEventListener('click', togglePanel);
  if (panelCloseBtn) panelCloseBtn.addEventListener('click', togglePanel);

  if (!isPanel && closeBtn) {
    closeBtn.addEventListener('click', () => {
      ipcRenderer.invoke('hide-bar');
    });
  }

  // Bar window: mantener estado "active" del gear sincronizado si el panel
  // se cierra externamente (taskbar, Alt+F4, etc.).
  ipcRenderer.on('panel-closed', () => {
    if (gearBtn) gearBtn.classList.remove('active');
  });

  if (minBtn) {
    minBtn.addEventListener('click', async () => {
      if (minimizedHwnds.length > 0) {
        await ipcRenderer.invoke('restore-wt', minimizedHwnds);
        minimizedHwnds = [];
        minBtn.textContent = '\u2584';
        minBtn.title = 'Minimizar todas las consolas';
      } else {
        minimizedHwnds = await ipcRenderer.invoke('minimize-all-wt');
        if (minimizedHwnds.length > 0) {
          minBtn.textContent = '\u25FB';
          minBtn.title = 'Restaurar consolas minimizadas';
        }
      }
    });
  }

  document.querySelectorAll('.panel-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.panel-tab').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      currentTab = btn.dataset.tab;
      loadTab(currentTab);
      try { ipcRenderer.invoke('track', 'panel_tab_view', { tab: currentTab }); } catch {}
    });
  });

  // Panel window: carga el tab inicial al estar listo el DOM.
  if (isPanel) loadTab('health');

  return { loadTab, togglePanel, getCurrentTab: () => currentTab };
}

module.exports = { initPanelCore };
