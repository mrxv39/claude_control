/** Shared utilities for electron-monitor lib modules. */

function escapeHtml(str) {
  return String(str || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
}

module.exports = { escapeHtml };
