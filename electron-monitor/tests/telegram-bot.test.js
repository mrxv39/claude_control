import { describe, it, expect, vi } from 'vitest';

const {
  TelegramBridge,
  parseCommand,
  buildInlineKeyboard,
  encodeCallbackData,
  parseCallbackData,
  formatQuestion,
  formatAlert,
} = require('../lib/telegram-bot');

// ---- parseCommand ----

describe('parseCommand', () => {
  it('parses simple command', () => {
    expect(parseCommand('/status')).toEqual({ command: 'status', args: [] });
  });

  it('parses command with args', () => {
    expect(parseCommand('/pause cars_control')).toEqual({ command: 'pause', args: ['cars_control'] });
  });

  it('combines note args in /goal command', () => {
    expect(parseCommand('/goal cars_control MVP-lanzable priorizar UX y rendimiento')).toEqual({
      command: 'goal',
      args: ['cars_control', 'MVP-lanzable', 'priorizar UX y rendimiento'],
    });
  });

  it('strips bot mentions', () => {
    expect(parseCommand('/status@claudio_bot')).toEqual({ command: 'status', args: [] });
  });

  it('lowercases command', () => {
    expect(parseCommand('/PAUSE X').command).toBe('pause');
  });

  it('returns null for non-commands', () => {
    expect(parseCommand('hola')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand('/')).toBeNull();
  });

  it('handles extra whitespace', () => {
    expect(parseCommand('  /feed   20  ').command).toBe('feed');
  });
});

// ---- buildInlineKeyboard / parseCallbackData ----

describe('buildInlineKeyboard', () => {
  it('maps options to rows with callback_data', () => {
    const kb = buildInlineKeyboard(
      [{ label: 'Sí', value: 'yes' }, { label: 'No', value: 'no' }],
      'qABC'
    );
    expect(kb).toHaveLength(2);
    expect(kb[0][0]).toEqual({ text: 'Sí', callback_data: 'qABC|yes' });
  });

  it('returns empty array for empty options', () => {
    expect(buildInlineKeyboard([], 'q')).toEqual([]);
    expect(buildInlineKeyboard(null, 'q')).toEqual([]);
  });
});

describe('encodeCallbackData', () => {
  it('joins with pipe', () => {
    expect(encodeCallbackData('qABC', 'yes')).toBe('qABC|yes');
  });

  it('truncates to 64 chars (Telegram limit)', () => {
    const long = 'x'.repeat(200);
    expect(encodeCallbackData('qABC', long).length).toBeLessThanOrEqual(64);
  });
});

describe('parseCallbackData', () => {
  it('splits on first pipe', () => {
    expect(parseCallbackData('qABC|yes')).toEqual({ questionId: 'qABC', answerValue: 'yes' });
  });

  it('preserves subsequent pipes in answer', () => {
    expect(parseCallbackData('q|a|b')).toEqual({ questionId: 'q', answerValue: 'a|b' });
  });

  it('returns null on malformed data', () => {
    expect(parseCallbackData('nopipe')).toBeNull();
    expect(parseCallbackData('|')).toBeNull();
    expect(parseCallbackData('q|')).toBeNull();
    expect(parseCallbackData(null)).toBeNull();
  });
});

// ---- formatQuestion ----

describe('formatQuestion', () => {
  it('includes project in header', () => {
    const { text } = formatQuestion({ id: 'q1', project: 'cars_control', question: '¿Sigo?' });
    expect(text).toContain('cars_control');
    expect(text).toContain('¿Sigo?');
  });

  it('attaches inline keyboard when options present', () => {
    const { options } = formatQuestion({
      id: 'q1', project: 'x', question: 'q',
      options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
    });
    expect(options.reply_markup.inline_keyboard).toHaveLength(2);
  });

  it('omits keyboard when no options', () => {
    const { options } = formatQuestion({ id: 'q1', project: 'x', question: 'q' });
    expect(options.reply_markup).toBeUndefined();
  });
});

// ---- formatAlert ----

describe('formatAlert', () => {
  it('prefixes with warning icon by default', () => {
    expect(formatAlert('algo raro')).toMatch(/⚠️/);
  });

  it('uses error icon for severity=error', () => {
    expect(formatAlert('boom', 'error')).toMatch(/🚨/);
  });

  it('uses info icon for severity=info', () => {
    expect(formatAlert('algo', 'info')).toMatch(/ℹ️/);
  });
});

// ---- TelegramBridge ----

function fakeClient() {
  const state = { sent: [], callbackAnswers: [] };
  let textHandler = null;
  let cbHandler = null;
  return {
    state,
    sendMessage: vi.fn(async (chatId, text, opts) => { state.sent.push({ chatId, text, opts }); return { ok: 1 }; }),
    onText: (fn) => { textHandler = fn; },
    onCallbackQuery: (fn) => { cbHandler = fn; },
    answerCallbackQuery: vi.fn(async (id) => { state.callbackAnswers.push(id); return true; }),
    emitText: (msg) => textHandler && textHandler(msg),
    emitCallback: (cb) => cbHandler && cbHandler(cb),
  };
}

describe('TelegramBridge — construction', () => {
  it('throws without client', () => {
    expect(() => new TelegramBridge({})).toThrow(/client/);
    expect(() => new TelegramBridge(null)).toThrow();
  });

  it('registers onText/onCallbackQuery if client supports them', () => {
    const c = fakeClient();
    new TelegramBridge({ chatId: 123, client: c });
    // Should not throw; handlers registered
    expect(() => c.emitText({ chat: { id: 123 }, text: '/status' })).not.toThrow();
  });
});

describe('TelegramBridge — sending', () => {
  it('sendText forwards to client with chatId', async () => {
    const c = fakeClient();
    const b = new TelegramBridge({ chatId: 123, client: c });
    const r = await b.sendText('hola');
    expect(r.ok).toBe(true);
    expect(c.state.sent[0]).toMatchObject({ chatId: 123, text: 'hola' });
  });

  it('sendDigest prefixes with icon', async () => {
    const c = fakeClient();
    const b = new TelegramBridge({ chatId: 123, client: c });
    await b.sendDigest('resumen');
    expect(c.state.sent[0].text).toMatch(/📰/);
    expect(c.state.sent[0].text).toContain('resumen');
  });

  it('sendAlert uses severity icons', async () => {
    const c = fakeClient();
    const b = new TelegramBridge({ chatId: 123, client: c });
    await b.sendAlert('fallo', 'error');
    expect(c.state.sent[0].text).toMatch(/🚨/);
  });

  it('askQuestion includes inline keyboard', async () => {
    const c = fakeClient();
    const b = new TelegramBridge({ chatId: 123, client: c });
    await b.askQuestion({
      id: 'q1', project: 'x', question: '¿Sigo?',
      options: [{ label: 'Sí', value: 'yes' }, { label: 'No', value: 'no' }],
    });
    expect(c.state.sent[0].opts.reply_markup.inline_keyboard).toHaveLength(2);
  });

  it('returns ok:false if sendMessage throws', async () => {
    const c = fakeClient();
    c.sendMessage = vi.fn(async () => { throw new Error('network'); });
    const b = new TelegramBridge({ chatId: 123, client: c });
    const r = await b.sendText('hola');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/network/);
  });

  it('returns no-chat-id when chatId missing', async () => {
    const c = fakeClient();
    const b = new TelegramBridge({ chatId: null, client: c });
    const r = await b.sendText('hola');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-chat-id');
  });
});

describe('TelegramBridge — receiving', () => {
  it('calls onCommand for allowed chat', () => {
    const c = fakeClient();
    const seen = [];
    new TelegramBridge({ chatId: 123, client: c, onCommand: (cmd) => seen.push(cmd) });
    c.emitText({ chat: { id: 123 }, text: '/status' });
    expect(seen).toEqual([{ command: 'status', args: [] }]);
  });

  it('ignores messages from other chats', () => {
    const c = fakeClient();
    const seen = [];
    new TelegramBridge({ chatId: 123, client: c, onCommand: (cmd) => seen.push(cmd) });
    c.emitText({ chat: { id: 999 }, text: '/status' });
    expect(seen).toEqual([]);
  });

  it('allowedChatIds overrides whitelist', () => {
    const c = fakeClient();
    const seen = [];
    new TelegramBridge({
      chatId: 123,
      client: c,
      onCommand: (cmd) => seen.push(cmd),
      allowedChatIds: ['123', '456'],
    });
    c.emitText({ chat: { id: 456 }, text: '/status' });
    expect(seen).toHaveLength(1);
  });

  it('ignores non-command messages', () => {
    const c = fakeClient();
    const seen = [];
    new TelegramBridge({ chatId: 123, client: c, onCommand: (cmd) => seen.push(cmd) });
    c.emitText({ chat: { id: 123 }, text: 'hola mundo' });
    expect(seen).toEqual([]);
  });

  it('calls onAnswer on callback query from allowed chat', () => {
    const c = fakeClient();
    const answers = [];
    new TelegramBridge({ chatId: 123, client: c, onAnswer: (a) => answers.push(a) });
    c.emitCallback({ id: 'cb1', from: { id: 123 }, data: 'q1|yes' });
    expect(answers).toEqual([{ questionId: 'q1', answerValue: 'yes' }]);
  });

  it('ignores callback from other chats', () => {
    const c = fakeClient();
    const answers = [];
    new TelegramBridge({ chatId: 123, client: c, onAnswer: (a) => answers.push(a) });
    c.emitCallback({ id: 'cb1', from: { id: 999 }, data: 'q1|yes' });
    expect(answers).toEqual([]);
  });

  it('acks callback queries via answerCallbackQuery', () => {
    const c = fakeClient();
    new TelegramBridge({ chatId: 123, client: c, onAnswer: () => {} });
    c.emitCallback({ id: 'cb1', from: { id: 123 }, data: 'q1|yes' });
    expect(c.answerCallbackQuery).toHaveBeenCalledWith('cb1');
  });
});
