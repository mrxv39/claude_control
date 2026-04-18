// renderer/common.js — helpers y constantes compartidas entre bar + panel + tabs.
// Se carga con nodeIntegration, por eso usamos CJS module.exports.

function esc(str) {
  return String(str || '').replace(/[<>&"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
  }[c]));
}

const COLORS = {
  green: '#9ece6a',
  yellow: '#e0af68',
  red: '#f7768e',
  blue: '#7aa2f7',
  purple: '#bb9af7',
  dim: '#565f89',
  priority: { high: '#9ece6a', medium: '#e0af68', low: '#7aa2f7', ignored: '#565f89' },
  pacing: { pace: '#9ece6a', accelerate: '#7aa2f7', burst: '#e0af68', coast: '#f7768e', wait: '#565f89' },
};

function rateColor(pct) {
  return pct < 50 ? COLORS.green : pct < 80 ? COLORS.yellow : COLORS.red;
}

// Mini helper para construir nodos DOM (reemplaza innerHTML en el tab Autónomo).
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'class') node.className = v;
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'text') node.textContent = v;
      else if (v != null) node.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

module.exports = { esc, COLORS, rateColor, el };
