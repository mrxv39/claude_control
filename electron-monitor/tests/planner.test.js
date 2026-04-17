import { describe, it, expect } from 'vitest';

const {
  routeModel,
  buildPrompt,
  parseResponse,
  applyGuardrails,
  buildConstraints,
  decide,
  COOLDOWN_MS,
} = require('../lib/planner');

const NOW = new Date('2026-04-18T12:00:00Z').getTime();
const HOUR = 3600000;

function proj(overrides = {}) {
  return {
    name: 'x',
    path: '/p/x',
    stack: 'node',
    objective: { template: 'MVP-lanzable' },
    evaluation: {
      met: false, satisfied: 1, total: 3,
      criteria: [
        { id: 'a', label: 'A', met: true, detail: 'OK' },
        { id: 'b', label: 'B', met: false, detail: 'Falta X' },
        { id: 'c', label: 'C', met: false, detail: 'Falta Y' },
      ],
    },
    preferredSkills: ['audit-claude-md', 'add-tests'],
    recentHistory: [],
    ...overrides,
  };
}

// ------------------- routeModel -------------------

describe('routeModel', () => {
  it('returns haiku for empty state', () => {
    expect(routeModel({ activeProjects: [] })).toBe('haiku');
  });

  it('returns haiku for 1 simple project', () => {
    expect(routeModel({ activeProjects: [proj({ evaluation: { ...proj().evaluation, criteria: [
      { id: 'a', met: false }, { id: 'b', met: true },
    ] } })] })).toBe('haiku');
  });

  it('returns opus for explorar-idea template', () => {
    const p = proj({ objective: { template: 'explorar-idea' } });
    expect(routeModel({ activeProjects: [p] })).toBe('opus');
  });

  it('returns opus when note contains creative keyword', () => {
    const p = proj({ objective: { template: 'MVP-lanzable', note: 'explorar nuevo approach' } });
    expect(routeModel({ activeProjects: [p] })).toBe('opus');
  });

  it('returns sonnet for 2+ projects with simple config', () => {
    expect(routeModel({ activeProjects: [proj(), proj({ name: 'y' })] })).toBe('sonnet');
  });

  it('returns sonnet when single project has free-text note', () => {
    const p = proj({ objective: { template: 'MVP-lanzable', note: 'priorizar rendimiento' } });
    expect(routeModel({ activeProjects: [p] })).toBe('sonnet');
  });

  it('returns sonnet when many unmet criteria', () => {
    const p = proj({
      evaluation: {
        met: false, satisfied: 0, total: 5,
        criteria: [
          { id: '1', met: false }, { id: '2', met: false }, { id: '3', met: false },
          { id: '4', met: false }, { id: '5', met: false },
        ],
      },
    });
    expect(routeModel({ activeProjects: [p] })).toBe('sonnet');
  });
});

// ------------------- buildPrompt -------------------

describe('buildPrompt', () => {
  it('returns no-op prompt when no active projects', () => {
    const prompt = buildPrompt({ activeProjects: [] });
    expect(prompt).toContain('no_op');
  });

  it('includes project name, objective and unmet criteria', () => {
    const prompt = buildPrompt({ activeProjects: [proj({ name: 'cars_control' })] });
    expect(prompt).toContain('cars_control');
    expect(prompt).toContain('MVP-lanzable');
    expect(prompt).toContain('b: Falta X');
    expect(prompt).toContain('c: Falta Y');
  });

  it('includes constraints when present', () => {
    const prompt = buildPrompt({
      activeProjects: [proj()],
      constraints: { blockedExecutions: [{ project: 'x', skill: 'add-tests', availableAt: NOW + 10 * HOUR }] },
      now: NOW,
    });
    expect(prompt).toContain('x:add-tests');
  });

  it('asks for JSON-only response', () => {
    const prompt = buildPrompt({ activeProjects: [proj()] });
    expect(prompt).toMatch(/SOLO con un objeto JSON/);
  });

  it('includes note in objective line when present', () => {
    const prompt = buildPrompt({
      activeProjects: [proj({ objective: { template: 'MVP-lanzable', note: 'priorizar UX' } })],
    });
    expect(prompt).toMatch(/MVP-lanzable — "priorizar UX"/);
  });
});

// ------------------- parseResponse -------------------

describe('parseResponse', () => {
  it('parses clean JSON run decision', () => {
    const raw = '{"decision":"run","project":"x","skill":"add-tests","reasoning":"falta tests"}';
    const r = parseResponse(raw);
    expect(r).toMatchObject({ decision: 'run', project: 'x', skill: 'add-tests', reasoning: 'falta tests' });
  });

  it('parses no_op decision', () => {
    const raw = '{"decision":"no_op","reasoning":"sin nada que hacer"}';
    const r = parseResponse(raw);
    expect(r.decision).toBe('no_op');
    expect(r.reasoning).toBe('sin nada que hacer');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"decision":"run","project":"x","skill":"a","reasoning":"r"}\n```';
    const r = parseResponse(raw);
    expect(r.decision).toBe('run');
    expect(r.project).toBe('x');
  });

  it('strips plain code fences', () => {
    const raw = '```\n{"decision":"no_op","reasoning":"r"}\n```';
    const r = parseResponse(raw);
    expect(r.decision).toBe('no_op');
  });

  it('extracts JSON from text with preamble', () => {
    const raw = 'Aquí tienes mi decisión:\n\n{"decision":"run","project":"x","skill":"a","reasoning":"r"}\n\nEso es todo.';
    const r = parseResponse(raw);
    expect(r.decision).toBe('run');
  });

  it('handles nested braces correctly', () => {
    const raw = '{"decision":"run","project":"x","skill":"a","reasoning":"ver {detalle}"}';
    const r = parseResponse(raw);
    expect(r.decision).toBe('run');
    expect(r.reasoning).toContain('detalle');
  });

  it('handles escaped quotes in strings', () => {
    const raw = '{"decision":"run","project":"x","skill":"a","reasoning":"he dicho \\"OK\\""}';
    const r = parseResponse(raw);
    expect(r.decision).toBe('run');
  });

  it('returns no_op with error on empty input', () => {
    const r = parseResponse('');
    expect(r.decision).toBe('no_op');
    expect(r.error).toBe('empty');
  });

  it('returns no_op on no JSON found', () => {
    const r = parseResponse('Algo sin objeto JSON alguno');
    expect(r.error).toBe('no-json');
  });

  it('returns no_op on unbalanced braces', () => {
    const r = parseResponse('{"decision":"run","project":"x"');
    expect(r.error).toBe('unbalanced');
  });

  it('returns no_op on invalid JSON', () => {
    const r = parseResponse('{"decision": notvalid}');
    expect(r.error).toBe('parse-error');
  });

  it('returns no_op for unknown decision value', () => {
    const raw = '{"decision":"maybe","reasoning":"r"}';
    const r = parseResponse(raw);
    expect(r.decision).toBe('no_op');
    expect(r.error).toBe('invalid-decision');
  });

  it('returns no_op when run decision lacks project/skill', () => {
    const raw = '{"decision":"run","reasoning":"r"}';
    const r = parseResponse(raw);
    expect(r.decision).toBe('no_op');
    expect(r.error).toBe('missing-fields');
  });
});

// ------------------- applyGuardrails -------------------

describe('applyGuardrails', () => {
  it('passes when decision is no_op', () => {
    expect(applyGuardrails({ decision: 'no_op', reasoning: 'r' }, { blockedExecutions: [] }).valid).toBe(true);
  });

  it('passes when no matching block exists', () => {
    const r = applyGuardrails(
      { decision: 'run', project: 'x', skill: 'a', reasoning: 'r' },
      { blockedExecutions: [{ project: 'y', skill: 'a', availableAt: NOW + HOUR }] },
      NOW
    );
    expect(r.valid).toBe(true);
  });

  it('blocks when matching cooldown is active', () => {
    const r = applyGuardrails(
      { decision: 'run', project: 'x', skill: 'a', reasoning: 'r' },
      { blockedExecutions: [{ project: 'x', skill: 'a', availableAt: NOW + 10 * HOUR }] },
      NOW
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/cooldown/);
    expect(r.reason).toMatch(/10h/);
  });

  it('allows when cooldown has already expired', () => {
    const r = applyGuardrails(
      { decision: 'run', project: 'x', skill: 'a', reasoning: 'r' },
      { blockedExecutions: [{ project: 'x', skill: 'a', availableAt: NOW - HOUR }] },
      NOW
    );
    expect(r.valid).toBe(true);
  });
});

// ------------------- buildConstraints -------------------

describe('buildConstraints', () => {
  it('creates blocks for successful runs within 72h window', () => {
    const history = [
      { project: 'x', skill: 'a', at: NOW - 10 * HOUR, outcome: 'ok' },
      { project: 'y', skill: 'b', at: NOW - 5 * HOUR, outcome: 'ok' },
    ];
    const blocks = buildConstraints(history);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].availableAt).toBe(NOW - 10 * HOUR + COOLDOWN_MS);
  });

  it('ignores failed runs', () => {
    const history = [{ project: 'x', skill: 'a', at: NOW - HOUR, outcome: 'fail' }];
    expect(buildConstraints(history)).toHaveLength(0);
  });

  it('handles null/empty input', () => {
    expect(buildConstraints(null)).toEqual([]);
    expect(buildConstraints([])).toEqual([]);
  });

  it('respects custom cooldown', () => {
    const history = [{ project: 'x', skill: 'a', at: NOW, outcome: 'ok' }];
    const blocks = buildConstraints(history, HOUR);
    expect(blocks[0].availableAt).toBe(NOW + HOUR);
  });
});

// ------------------- decide (DI invoke) -------------------

describe('decide (with injected invoke)', () => {
  it('returns no_op when no active projects', async () => {
    const r = await decide({ activeProjects: [] });
    expect(r.decision).toBe('no_op');
    expect(r.reasoning).toMatch(/sin proyectos/);
  });

  it('calls invoke with chosen model + built prompt and parses result', async () => {
    const calls = [];
    const invoke = async (model, prompt) => {
      calls.push({ model, prompt });
      return '{"decision":"run","project":"x","skill":"audit-claude-md","reasoning":"hay que documentar"}';
    };
    const r = await decide({ activeProjects: [proj()] }, { invoke });
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('x');
    expect(r.decision).toBe('run');
    expect(r.skill).toBe('audit-claude-md');
    expect(r.model).toBe('haiku');
  });

  it('returns no_op when invoke throws', async () => {
    const invoke = async () => { throw new Error('boom'); };
    const r = await decide({ activeProjects: [proj()] }, { invoke });
    expect(r.decision).toBe('no_op');
    expect(r.error).toBe('invoke-error');
    expect(r.reasoning).toMatch(/boom/);
  });

  it('applies guardrails on valid run decisions', async () => {
    const invoke = async () => '{"decision":"run","project":"x","skill":"a","reasoning":"r"}';
    const r = await decide(
      {
        activeProjects: [proj()],
        constraints: { blockedExecutions: [{ project: 'x', skill: 'a', availableAt: NOW + 10 * HOUR }] },
        now: NOW,
      },
      { invoke }
    );
    expect(r.decision).toBe('no_op');
    expect(r.error).toBe('guardrail');
  });

  it('respects modelOverride', async () => {
    let usedModel = null;
    const invoke = async (model) => { usedModel = model; return '{"decision":"no_op","reasoning":"r"}'; };
    await decide({ activeProjects: [proj()] }, { invoke, modelOverride: 'opus' });
    expect(usedModel).toBe('opus');
  });
});
