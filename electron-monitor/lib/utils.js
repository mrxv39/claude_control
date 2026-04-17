/** Shared utilities for electron-monitor lib modules. */

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string|number|null|undefined} str - Value to escape
 * @returns {string} Escaped HTML-safe string
 */
function escapeHtml(str) {
  return String(str || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
}

module.exports = { escapeHtml };
