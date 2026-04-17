import { describe, it, expect } from 'vitest';

const {
  calculateVelocity,
  estimateDaysToGoal,
  forecastCompletion,
  prioritizeByUrgency,
  describeForecast,
} = require('../lib/forecast');

const DAY_MS = 86400000;
const NOW = new Date('2026-04-18T12:00:00Z').getTime();

function daysAgo(n) { return NOW - n * DAY_MS; }

// ---- calculateVelocity ----

describe('calculateVelocity', () => {
  it('returns 0 for empty history', () => {
    expect(calculateVelocity([], { now: NOW })).toBe(0);
    expect(calculateVelocity(null, { now: NOW })).toBe(0);
  });

  it('counts only successful runs', () => {
    const history = [
      { skill: 'a', outcome: 'ok', at: daysAgo(1) },
      { skill: 'b', outcome: 'fail', at: daysAgo(2) },
      { skill: 'c', outcome: 'ok', at: daysAgo(3) },
    ];
    const v = calculateVelocity(history, { now: NOW, windowDays: 14 });
    expect(v).toBeCloseTo(2 / 14, 3);
  });

  it('ignores runs outside window', () => {
    const history = [
      { skill: 'a', outcome: 'ok', at: daysAgo(5) },
      { skill: 'b', outcome: 'ok', at: daysAgo(30) },
    ];
    const v = calculateVelocity(history, { now: NOW, windowDays: 14 });
    expect(v).toBeCloseTo(1 / 14, 3);
  });

  it('respects custom window', () => {
    const history = [
      { skill: 'a', outcome: 'ok', at: daysAgo(1) },
      { skill: 'b', outcome: 'ok', at: daysAgo(6) },
    ];
    const short = calculateVelocity(history, { now: NOW, windowDays: 3 });
    const long = calculateVelocity(history, { now: NOW, windowDays: 14 });
    expect(short).toBeCloseTo(1 / 3, 3);
    expect(long).toBeCloseTo(2 / 14, 3);
  });
});

// ---- estimateDaysToGoal ----

describe('estimateDaysToGoal', () => {
  it('returns 0 for no unmet', () => {
    expect(estimateDaysToGoal(0, 1)).toBe(0);
  });

  it('returns null when velocity is 0', () => {
    expect(estimateDaysToGoal(3, 0)).toBeNull();
  });

  it('calculates days needed with default effectiveness', () => {
    // 2 criterios, velocity 0.5/día, effectiveness 0.5 → 2 / 0.25 = 8 días
    expect(estimateDaysToGoal(2, 0.5)).toBe(8);
  });

  it('rounds up to whole days', () => {
    // 1 criterio, velocity 0.2/día, effectiveness 0.5 → 1 / 0.1 = 10 días
    expect(estimateDaysToGoal(1, 0.2)).toBe(10);
  });

  it('respects custom skillEffectiveness', () => {
    // 2 criterios, velocity 1/día, effectiveness 1.0 → 2 días
    expect(estimateDaysToGoal(2, 1, 1)).toBe(2);
    // effectiveness 0.25 → 2 / 0.25 = 8
    expect(estimateDaysToGoal(2, 1, 0.25)).toBe(8);
  });
});

// ---- forecastCompletion ----

function mkHistory(days) {
  return days.map(d => ({ skill: 's', outcome: 'ok', at: daysAgo(d) }));
}

describe('forecastCompletion — status transitions', () => {
  it('already-met when 0 unmet', () => {
    const r = forecastCompletion(
      { objective: { deadline: '2026-05-01' }, history: mkHistory([1, 2]) },
      { satisfied: 5, total: 5 },
      { now: NOW }
    );
    expect(r.status).toBe('already-met');
  });

  it('insufficient-data when velocity is 0', () => {
    const r = forecastCompletion(
      { objective: { deadline: '2026-05-01' }, history: [] },
      { satisfied: 0, total: 3 },
      { now: NOW }
    );
    expect(r.status).toBe('insufficient-data');
    expect(r.daysNeeded).toBeNull();
  });

  it('no-deadline when deadline absent', () => {
    const r = forecastCompletion(
      { objective: {}, history: mkHistory([1, 2, 3]) },
      { satisfied: 1, total: 3 },
      { now: NOW }
    );
    expect(r.status).toBe('no-deadline');
    expect(r.predictedCompletionDate).toBeTruthy();
  });

  it('on-track when daysNeeded fits deadline', () => {
    const history = mkHistory(Array.from({ length: 10 }, (_, i) => i + 1));
    const deadline = new Date(NOW + 60 * DAY_MS).toISOString().slice(0, 10);
    const r = forecastCompletion(
      { objective: { deadline }, history },
      { satisfied: 3, total: 5 },
      { now: NOW }
    );
    expect(r.status).toBe('on-track');
  });

  it('at-risk when daysNeeded exceeds deadline', () => {
    // 1 skill en 14d → velocity 0.07; 5 criterios con effectiveness 0.5 → ~140d
    const history = [{ skill: 's', outcome: 'ok', at: daysAgo(5) }];
    const deadline = new Date(NOW + 30 * DAY_MS).toISOString().slice(0, 10);
    const r = forecastCompletion(
      { objective: { deadline }, history },
      { satisfied: 0, total: 5 },
      { now: NOW }
    );
    expect(r.status).toBe('at-risk');
  });

  it('impossible when deadline already passed', () => {
    const deadline = new Date(NOW - 5 * DAY_MS).toISOString().slice(0, 10);
    const history = mkHistory([1, 2, 3]);
    const r = forecastCompletion(
      { objective: { deadline }, history },
      { satisfied: 0, total: 3 },
      { now: NOW }
    );
    expect(r.status).toBe('impossible');
  });

  it('handles invalid deadline string as no-deadline', () => {
    const r = forecastCompletion(
      { objective: { deadline: 'not-a-date' }, history: mkHistory([1, 2]) },
      { satisfied: 0, total: 3 },
      { now: NOW }
    );
    expect(r.status).toBe('no-deadline');
  });
});

// ---- prioritizeByUrgency ----

describe('prioritizeByUrgency', () => {
  it('puts impossible first', () => {
    const projects = [
      { name: 'onTrack', forecast: { status: 'on-track', daysUntilDeadline: 20 } },
      { name: 'impossible', forecast: { status: 'impossible', daysUntilDeadline: -5 } },
      { name: 'atRisk', forecast: { status: 'at-risk', daysUntilDeadline: 3 } },
    ];
    const r = prioritizeByUrgency(projects);
    expect(r[0].name).toBe('impossible');
    expect(r[1].name).toBe('atRisk');
    expect(r[2].name).toBe('onTrack');
  });

  it('ranks at-risk by how close the deadline is', () => {
    const projects = [
      { name: 'farRisk', forecast: { status: 'at-risk', daysUntilDeadline: 25 } },
      { name: 'closeRisk', forecast: { status: 'at-risk', daysUntilDeadline: 3 } },
    ];
    const r = prioritizeByUrgency(projects);
    expect(r[0].name).toBe('closeRisk');
  });

  it('ignores null/invalid entries', () => {
    expect(prioritizeByUrgency([null, {}, { name: 'x' }])).toEqual([]);
  });
});

// ---- describeForecast ----

describe('describeForecast', () => {
  it('returns readable string for each status', () => {
    expect(describeForecast({ status: 'already-met' })).toMatch(/cumplido/);
    expect(describeForecast({ status: 'on-track', predictedCompletionDate: '2026-05-01', daysNeeded: 10, daysUntilDeadline: 20 })).toMatch(/2026-05-01/);
    expect(describeForecast({ status: 'at-risk', daysNeeded: 30, daysUntilDeadline: 10 })).toMatch(/NO se alcanza/);
    expect(describeForecast({ status: 'impossible', daysUntilDeadline: -5 })).toMatch(/vencido/);
    expect(describeForecast({ status: 'insufficient-data', unmetCount: 3 })).toMatch(/Sin historial/);
  });

  it('handles null input', () => {
    expect(describeForecast(null)).toBe('');
  });
});
