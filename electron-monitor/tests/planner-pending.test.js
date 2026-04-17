import { describe, it, expect } from 'vitest';

const {
  addPending,
  answerPending,
  expireOld,
  getUnanswered,
  findDuplicatePending,
  findById,
  prune,
} = require('../lib/planner-pending');

const HOUR_MS = 3600 * 1000;
const NOW = new Date('2026-04-18T12:00:00Z').getTime();

function baseQuestion(overrides = {}) {
  return {
    type: 'planner-stuck',
    project: 'cars_control',
    question: '¿Sigues o pauso?',
    options: [
      { label: 'Continuar', value: 'continue' },
      { label: 'Pausar', value: 'pause' },
    ],
    ...overrides,
  };
}

// ---- addPending ----

describe('addPending', () => {
  it('adds a new question with generated id and timestamps', () => {
    const { queue, added } = addPending([], baseQuestion(), { now: NOW });
    expect(queue).toHaveLength(1);
    expect(added.id).toMatch(/^q/);
    expect(added.createdAt).toBe(NOW);
    expect(added.expiresAt).toBe(NOW + 12 * HOUR_MS);
    expect(added.status).toBe('pending');
  });

  it('respects custom timeoutHours', () => {
    const { added } = addPending([], baseQuestion(), { now: NOW, timeoutHours: 2 });
    expect(added.expiresAt).toBe(NOW + 2 * HOUR_MS);
  });

  it('preserves existing queue (no mutation)', () => {
    const prior = [{ id: 'old', status: 'answered' }];
    const { queue } = addPending(prior, baseQuestion(), { now: NOW });
    expect(queue).toHaveLength(2);
    expect(prior).toHaveLength(1);
  });

  it('applies defaults when fields missing', () => {
    const { added } = addPending([], {}, { now: NOW });
    expect(added.type).toBe('custom');
    expect(added.project).toBe('');
    expect(added.options).toBeUndefined();
  });
});

// ---- answerPending ----

describe('answerPending', () => {
  it('answers a valid pending question', () => {
    const { queue, added } = addPending([], baseQuestion(), { now: NOW });
    const r = answerPending(queue, added.id, 'continue', { now: NOW + 100 });
    expect(r.error).toBeUndefined();
    expect(r.updated.status).toBe('answered');
    expect(r.updated.answer).toBe('continue');
    expect(r.updated.answeredAt).toBe(NOW + 100);
  });

  it('rejects answer not in options', () => {
    const { queue, added } = addPending([], baseQuestion(), { now: NOW });
    const r = answerPending(queue, added.id, 'unknown', { now: NOW });
    expect(r.updated).toBeNull();
    expect(r.error).toBe('answer-not-in-options');
  });

  it('accepts free-text when no options defined', () => {
    const { queue, added } = addPending(
      [],
      { ...baseQuestion(), options: undefined },
      { now: NOW }
    );
    const r = answerPending(queue, added.id, 'texto libre', { now: NOW });
    expect(r.error).toBeUndefined();
    expect(r.updated.answer).toBe('texto libre');
  });

  it('returns not-found for unknown id', () => {
    const r = answerPending([], 'nope', 'x', { now: NOW });
    expect(r.error).toBe('not-found');
  });

  it('rejects already answered questions', () => {
    const { queue, added } = addPending([], baseQuestion(), { now: NOW });
    const first = answerPending(queue, added.id, 'continue', { now: NOW });
    const second = answerPending(first.queue, added.id, 'pause', { now: NOW });
    expect(second.error).toMatch(/ya answered/);
  });

  it('rejects expired questions', () => {
    const { queue, added } = addPending([], baseQuestion(), { now: NOW });
    const r = answerPending(queue, added.id, 'continue', { now: NOW + 13 * HOUR_MS });
    expect(r.error).toBe('expired');
  });
});

// ---- expireOld ----

describe('expireOld', () => {
  it('marks expired questions and applies defaultAnswer', () => {
    let q = [];
    ({ queue: q } = addPending(q, { ...baseQuestion(), defaultAnswer: 'pause' }, { now: NOW, timeoutHours: 1 }));
    const r = expireOld(q, { now: NOW + 2 * HOUR_MS });
    expect(r.expired).toHaveLength(1);
    expect(r.expired[0].status).toBe('expired');
    expect(r.expired[0].answer).toBe('pause');
  });

  it('leaves non-expired alone', () => {
    const { queue } = addPending([], baseQuestion(), { now: NOW, timeoutHours: 12 });
    const r = expireOld(queue, { now: NOW + HOUR_MS });
    expect(r.expired).toHaveLength(0);
  });

  it('handles empty queue', () => {
    const r = expireOld(null, { now: NOW });
    expect(r.queue).toEqual([]);
    expect(r.expired).toEqual([]);
  });
});

// ---- getUnanswered ----

describe('getUnanswered', () => {
  it('returns only pending non-expired questions', () => {
    let q = [];
    ({ queue: q } = addPending(q, baseQuestion(), { now: NOW, timeoutHours: 10 }));
    ({ queue: q } = addPending(q, baseQuestion(), { now: NOW, timeoutHours: 10 }));
    const r = answerPending(q, q[0].id, 'continue', { now: NOW });
    const unanswered = getUnanswered(r.queue, { now: NOW });
    expect(unanswered).toHaveLength(1);
    expect(unanswered[0].id).toBe(q[1].id);
  });

  it('excludes expired even if not yet marked', () => {
    const { queue } = addPending([], baseQuestion(), { now: NOW, timeoutHours: 1 });
    const unanswered = getUnanswered(queue, { now: NOW + 2 * HOUR_MS });
    expect(unanswered).toHaveLength(0);
  });
});

// ---- findDuplicatePending ----

describe('findDuplicatePending', () => {
  it('finds existing pending by project + type', () => {
    const { queue } = addPending([], baseQuestion({ project: 'x', type: 'planner-stuck' }), { now: NOW });
    const dup = findDuplicatePending(queue, { project: 'x', type: 'planner-stuck' }, { now: NOW });
    expect(dup).not.toBeNull();
  });

  it('returns null when type or project differ', () => {
    const { queue } = addPending([], baseQuestion({ project: 'x', type: 'planner-stuck' }), { now: NOW });
    expect(findDuplicatePending(queue, { project: 'y', type: 'planner-stuck' }, { now: NOW })).toBeNull();
    expect(findDuplicatePending(queue, { project: 'x', type: 'other' }, { now: NOW })).toBeNull();
  });

  it('ignores answered questions', () => {
    const { queue, added } = addPending([], baseQuestion({ project: 'x' }), { now: NOW });
    const answered = answerPending(queue, added.id, 'continue', { now: NOW });
    expect(findDuplicatePending(answered.queue, { project: 'x', type: 'planner-stuck' }, { now: NOW })).toBeNull();
  });
});

// ---- findById ----

describe('findById', () => {
  it('returns question by id', () => {
    const { queue, added } = addPending([], baseQuestion(), { now: NOW });
    expect(findById(queue, added.id)).toBe(added);
  });

  it('returns null when id missing', () => {
    expect(findById([], 'x')).toBeNull();
    expect(findById(null, 'x')).toBeNull();
  });
});

// ---- prune ----

describe('prune', () => {
  it('keeps all pending and last N resolved', () => {
    const q = [];
    for (let i = 0; i < 10; i++) q.push({ id: `a${i}`, status: 'answered', answeredAt: NOW - i });
    q.push({ id: 'p1', status: 'pending', expiresAt: NOW + HOUR_MS });
    const pruned = prune(q, { keep: 3 });
    expect(pruned.filter(x => x.status === 'pending')).toHaveLength(1);
    expect(pruned.filter(x => x.status === 'answered')).toHaveLength(3);
  });

  it('keeps newest resolved first', () => {
    const q = [
      { id: 'old', status: 'answered', answeredAt: NOW - 1000 },
      { id: 'new', status: 'answered', answeredAt: NOW },
    ];
    const pruned = prune(q, { keep: 1 });
    expect(pruned[0].id).toBe('new');
  });
});
