/**
 * telegram-bot.js — Bridge bidireccional con Telegram.
 *
 * Permite al orquestador autónomo:
 *   - Enviar digest matutino, alertas críticas
 *   - Hacer preguntas al usuario con botones inline (callback_data)
 *   - Recibir comandos (/status, /pause X, /activate X, /goal X T)
 *   - Recibir respuestas a preguntas pendientes
 *
 * El cliente Telegram se inyecta (DI) → los tests usan un fake.
 * En runtime, un wrapper alrededor de `node-telegram-bot-api` lo provee.
 *
 * @typedef {Object} TelegramClient
 * @property {(chatId: string|number, text: string, opts?: any) => Promise<any>} sendMessage
 * @property {(fn: (msg: {chat: {id: any}, text?: string}) => void) => void} [onText]
 * @property {(fn: (cb: {data: string, from: {id: any}, message?: any}) => void) => void} [onCallbackQuery]
 * @property {(cbId: string, opts?: any) => Promise<any>} [answerCallbackQuery]
 */

// ---- Pure helpers ----

/**
 * Parsea un mensaje de Telegram en comando + args.
 *   "/status"                     → { command: 'status', args: [] }
 *   "/pause cars_control"         → { command: 'pause', args: ['cars_control'] }
 *   "/goal cars_control MVP-lanzable priorizar UX"
 *                                 → { command: 'goal', args: ['cars_control', 'MVP-lanzable', 'priorizar UX'] }
 * Los comandos multi-arg combinan el último argumento con el resto (nota libre).
 *
 * @param {string} text
 * @returns {{command: string, args: string[]}|null}
 */
function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).split(/\s+/);
  const command = (parts[0] || '').toLowerCase().replace(/@.*/, ''); // strip bot mention
  if (!command) return null;
  const rest = parts.slice(1);
  // Comandos especiales con nota libre (3er+ arg combinados)
  if (command === 'goal' && rest.length >= 3) {
    return { command, args: [rest[0], rest[1], rest.slice(2).join(' ')] };
  }
  return { command, args: rest };
}

/**
 * Construye un teclado inline de Telegram a partir de opciones + id de la pregunta.
 *
 * @param {Array<{label: string, value: string}>} options
 * @param {string} questionId
 * @returns {Array<Array<{text: string, callback_data: string}>>}
 */
function buildInlineKeyboard(options, questionId) {
  if (!Array.isArray(options) || !options.length) return [];
  return options.map(o => ([
    { text: o.label, callback_data: `${questionId}|${o.value}` },
  ]));
}

/**
 * Encoda callback_data. Formato `<id>|<value>` con cap de 64 chars (límite de Telegram).
 * @param {string} questionId
 * @param {string} value
 */
function encodeCallbackData(questionId, value) {
  const raw = `${questionId}|${value}`;
  return raw.length > 64 ? raw.slice(0, 64) : raw;
}

/**
 * Decoda callback_data recibido.
 * @param {string} data
 * @returns {{questionId: string, answerValue: string}|null}
 */
function parseCallbackData(data) {
  if (typeof data !== 'string') return null;
  const idx = data.indexOf('|');
  if (idx === -1) return null;
  const questionId = data.slice(0, idx);
  const answerValue = data.slice(idx + 1);
  if (!questionId || !answerValue) return null;
  return { questionId, answerValue };
}

/**
 * Formatea una PendingQuestion para envío.
 * @param {{id: string, question: string, project: string, options?: any[]}} question
 */
function formatQuestion(question) {
  const header = question.project ? `🤖 *${question.project}*` : '🤖';
  const text = `${header}\n\n${question.question}`;
  const keyboard = Array.isArray(question.options) && question.options.length
    ? buildInlineKeyboard(question.options, question.id)
    : undefined;
  return {
    text,
    options: keyboard
      ? { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
      : { parse_mode: 'Markdown' },
  };
}

function formatAlert(text, severity = 'warning') {
  const icon = severity === 'error' ? '🚨' : severity === 'info' ? 'ℹ️' : '⚠️';
  return `${icon} ${text}`;
}

// ---- Bridge (stateful, I/O via DI) ----

class TelegramBridge {
  /**
   * @param {{chatId: string|number, client: TelegramClient, onCommand?: Function, onAnswer?: Function, allowedChatIds?: Set}} deps
   */
  constructor(deps) {
    if (!deps || !deps.client) throw new Error('TelegramBridge requires {client}');
    this.chatId = deps.chatId;
    this.client = deps.client;
    this.onCommand = deps.onCommand;
    this.onAnswer = deps.onAnswer;
    // Whitelist de chat IDs autorizados (por defecto solo chatId propio)
    this.allowedChatIds = new Set(deps.allowedChatIds || [String(deps.chatId)]);

    if (typeof this.client.onText === 'function') {
      this.client.onText((msg) => this._handleMessage(msg));
    }
    if (typeof this.client.onCallbackQuery === 'function') {
      this.client.onCallbackQuery((cb) => this._handleCallback(cb));
    }
  }

  async sendText(text, opts = {}) {
    if (!this.chatId) return { ok: false, error: 'no-chat-id' };
    try {
      await this.client.sendMessage(this.chatId, text, opts);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async sendDigest(text) {
    return this.sendText(`📰 Digest diario\n\n${text}`, { parse_mode: 'Markdown' });
  }

  async sendAlert(text, severity) {
    return this.sendText(formatAlert(text, severity));
  }

  async askQuestion(question) {
    const { text, options } = formatQuestion(question);
    return this.sendText(text, options);
  }

  _isAllowed(chatId) {
    return this.allowedChatIds.has(String(chatId));
  }

  _handleMessage(msg) {
    if (!msg || !msg.chat || !this._isAllowed(msg.chat.id)) return;
    if (typeof msg.text !== 'string') return;
    const parsed = parseCommand(msg.text);
    if (parsed && typeof this.onCommand === 'function') {
      try { this.onCommand(parsed, msg); } catch {}
    }
  }

  _handleCallback(cb) {
    if (!cb || !cb.from || !this._isAllowed(cb.from.id)) return;
    const parsed = parseCallbackData(cb.data);
    if (parsed && typeof this.onAnswer === 'function') {
      try { this.onAnswer(parsed, cb); } catch {}
    }
    // Best-effort ack al callback (pero DI: si no existe, noop)
    if (typeof this.client.answerCallbackQuery === 'function' && cb.id) {
      this.client.answerCallbackQuery(cb.id).catch(() => {});
    }
  }
}

module.exports = {
  TelegramBridge,
  parseCommand,
  buildInlineKeyboard,
  encodeCallbackData,
  parseCallbackData,
  formatQuestion,
  formatAlert,
};
