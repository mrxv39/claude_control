/**
 * planner-pending.js — Cola de preguntas pendientes del planner al usuario.
 *
 * Cuando el planner detecta ambigüedad (atasco, objetivo incoherente,
 * hallazgo crítico) emite una "pregunta" que queda en cola hasta que el
 * usuario responda (por Telegram, UI, etc.) o expire.
 *
 * Módulo puro. El caller persiste en pending-questions.json.
 *
 * @typedef {Object} PendingQuestion
 * @property {string} id - UUID o timestamp hex
 * @property {string} type - 'planner-stuck'|'objective-conflict'|'propose-new-goal'|'critical-finding'|'custom'
 * @property {string} project - proyecto afectado
 * @property {string} question - texto humano
 * @property {Array<{label: string, value: string}>} [options] - opciones fijas; si falta, texto libre
 * @property {string} [defaultAnswer] - respuesta aplicada al expirar
 * @property {number} createdAt - epoch ms
 * @property {number} expiresAt - epoch ms
 * @property {'pending'|'answered'|'expired'} status
 * @property {string} [answer] - valor elegido
 * @property {number} [answeredAt]
 */

const DEFAULT_TIMEOUT_HOURS = 12;
const HOUR_MS = 3600 * 1000;

function genId(now) {
  return `q${Math.floor((now ?? Date.now())).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Añade una pregunta a la cola.
 *
 * @param {PendingQuestion[]} queue
 * @param {Omit<PendingQuestion, 'id'|'createdAt'|'expiresAt'|'status'>} input
 * @param {{now?: number, timeoutHours?: number}} [opts]
 * @returns {{queue: PendingQuestion[], added: PendingQuestion}}
 */
function addPending(queue, input, opts = {}) {
  const now = opts.now ?? Date.now();
  const timeoutHours = opts.timeoutHours ?? DEFAULT_TIMEOUT_HOURS;
  const added = {
    id: genId(now),
    type: input.type || 'custom',
    project: input.project || '',
    question: input.question || '',
    options: Array.isArray(input.options) ? input.options : undefined,
    defaultAnswer: input.defaultAnswer,
    createdAt: now,
    expiresAt: now + timeoutHours * HOUR_MS,
    status: 'pending',
  };
  return { queue: [...(queue || []), added], added };
}

/**
 * Registra una respuesta. Si la pregunta tiene `options` válidas, exige que
 * `answer` sea uno de los values; si no, acepta texto libre.
 *
 * @param {PendingQuestion[]} queue
 * @param {string} id
 * @param {string} answer
 * @param {{now?: number}} [opts]
 * @returns {{queue: PendingQuestion[], updated: PendingQuestion|null, error?: string}}
 */
function answerPending(queue, id, answer, opts = {}) {
  const now = opts.now ?? Date.now();
  const idx = (queue || []).findIndex(q => q && q.id === id);
  if (idx === -1) return { queue: queue || [], updated: null, error: 'not-found' };
  const q = queue[idx];
  if (q.status !== 'pending') return { queue, updated: null, error: `ya ${q.status}` };
  if (q.expiresAt <= now) return { queue, updated: null, error: 'expired' };

  if (Array.isArray(q.options) && q.options.length > 0) {
    const valid = q.options.some(o => o.value === answer);
    if (!valid) return { queue, updated: null, error: 'answer-not-in-options' };
  }

  const updated = { ...q, status: 'answered', answer, answeredAt: now };
  const next = [...queue];
  next[idx] = updated;
  return { queue: next, updated };
}

/**
 * Marca como expiradas las preguntas vencidas (aplicando defaultAnswer si existe).
 *
 * @param {PendingQuestion[]} queue
 * @param {{now?: number}} [opts]
 * @returns {{queue: PendingQuestion[], expired: PendingQuestion[]}}
 */
function expireOld(queue, opts = {}) {
  const now = opts.now ?? Date.now();
  const expired = [];
  const next = (queue || []).map(q => {
    if (!q || q.status !== 'pending' || q.expiresAt > now) return q;
    const up = {
      ...q,
      status: 'expired',
      answer: q.defaultAnswer,
      answeredAt: now,
    };
    expired.push(up);
    return up;
  });
  return { queue: next, expired };
}

/**
 * Preguntas aún esperando respuesta (no expiradas ni respondidas).
 * @param {PendingQuestion[]} queue
 * @param {{now?: number}} [opts]
 * @returns {PendingQuestion[]}
 */
function getUnanswered(queue, opts = {}) {
  const now = opts.now ?? Date.now();
  return (queue || []).filter(q => q && q.status === 'pending' && q.expiresAt > now);
}

/**
 * ¿Hay ya una pregunta pendiente para este proyecto + tipo?
 * Evita spam: si el planner ya preguntó, no preguntar de nuevo hasta resolver.
 *
 * @param {PendingQuestion[]} queue
 * @param {{project: string, type: string}} filter
 * @param {{now?: number}} [opts]
 * @returns {PendingQuestion|null}
 */
function findDuplicatePending(queue, filter, opts = {}) {
  const unanswered = getUnanswered(queue, opts);
  return unanswered.find(q => q.project === filter.project && q.type === filter.type) || null;
}

function findById(queue, id) {
  return (queue || []).find(q => q && q.id === id) || null;
}

/**
 * Limpia preguntas viejas ya resueltas/expiradas para no crecer sin límite.
 * Mantiene las últimas `keep` respondidas/expiradas además de todas las pending.
 *
 * @param {PendingQuestion[]} queue
 * @param {{keep?: number}} [opts]
 * @returns {PendingQuestion[]}
 */
function prune(queue, opts = {}) {
  const keep = opts.keep ?? 50;
  const pending = (queue || []).filter(q => q?.status === 'pending');
  const resolved = (queue || [])
    .filter(q => q?.status !== 'pending')
    .sort((a, b) => (b.answeredAt || 0) - (a.answeredAt || 0))
    .slice(0, keep);
  return [...pending, ...resolved];
}

module.exports = {
  addPending,
  answerPending,
  expireOld,
  getUnanswered,
  findDuplicatePending,
  findById,
  prune,
  DEFAULT_TIMEOUT_HOURS,
};
