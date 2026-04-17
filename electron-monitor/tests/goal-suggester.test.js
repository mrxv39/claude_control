import { describe, it, expect } from 'vitest';

const {
  heuristicSuggest,
  buildSuggestionPrompt,
  parseSuggestion,
  suggest,
  VALID_TEMPLATES,
} = require('../lib/goal-suggester');

// ---- heuristicSuggest ----

describe('heuristicSuggest — security triggers', () => {
  it('suggests seguro-y-testeado when README mentions auth', () => {
    const s = heuristicSuggest({
      readme: 'Este proyecto gestiona autenticación y login de usuarios',
      score: 6,
    });
    expect(s.template).toBe('seguro-y-testeado');
    expect(s.confidence).toBeGreaterThan(0.7);
  });

  it('detects "pagos" keyword', () => {
    const s = heuristicSuggest({ readme: 'Backend para pagos con Stripe', score: 7 });
    expect(s.template).toBe('seguro-y-testeado');
  });

  it('detects "api pública"', () => {
    const s = heuristicSuggest({ readme: 'Esto expone una API pública', score: 7 });
    expect(s.template).toBe('seguro-y-testeado');
  });

  it('detects "oauth" / "jwt" / "token"', () => {
    expect(heuristicSuggest({ readme: 'OAuth flow' }).template).toBe('seguro-y-testeado');
    expect(heuristicSuggest({ readme: 'JWT tokens' }).template).toBe('seguro-y-testeado');
  });
});

describe('heuristicSuggest — maduro/producción', () => {
  it('production-ready when all boxes checked', () => {
    const s = heuristicSuggest({
      score: 8,
      checks: { hasClaude: true, hasTests: true, hasGitignore: true, gitClean: true, depsOk: true },
      recentCommits: 1,
      lastCommitDays: 20,
    });
    expect(s.template).toBe('production-ready');
    expect(s.confidence).toBeGreaterThan(0.8);
  });

  it('does not suggest production-ready when score < 8', () => {
    const s = heuristicSuggest({
      score: 7,
      checks: { hasClaude: true, hasTests: true, depsOk: true },
    });
    expect(s.template).not.toBe('production-ready');
  });
});

describe('heuristicSuggest — MVP-lanzable', () => {
  it('active dev with tests → MVP-lanzable', () => {
    const s = heuristicSuggest({
      recentCommits: 10,
      checks: { hasTests: true },
      score: 6,
    });
    expect(s.template).toBe('MVP-lanzable');
  });

  it('active dev with score >=6 but no tests → MVP-lanzable', () => {
    const s = heuristicSuggest({ recentCommits: 5, score: 7, checks: {} });
    expect(s.template).toBe('MVP-lanzable');
  });
});

describe('heuristicSuggest — mantenimiento', () => {
  it('stable mature project with low activity', () => {
    const s = heuristicSuggest({
      score: 7,
      lastCommitDays: 45,
      recentCommits: 0,
      checks: {},
    });
    expect(s.template).toBe('mantenimiento');
  });

  it('does not choose mantenimiento if abandoned (>90d)', () => {
    const s = heuristicSuggest({
      score: 7,
      lastCommitDays: 120,
      recentCommits: 0,
      checks: {},
    });
    expect(s.template).not.toBe('mantenimiento');
  });
});

describe('heuristicSuggest — explorar-idea', () => {
  it('no CLAUDE, no tests, low activity → explorar-idea', () => {
    const s = heuristicSuggest({
      checks: { hasClaude: false, hasTests: false },
      recentCommits: 1,
    });
    expect(s.template).toBe('explorar-idea');
  });
});

describe('heuristicSuggest — fallback', () => {
  it('returns low-confidence MVP-lanzable when no signals', () => {
    const s = heuristicSuggest({
      score: 5,
      checks: { hasClaude: true, hasTests: true },
      recentCommits: 0,
      lastCommitDays: 10,
    });
    expect(s.confidence).toBeLessThan(0.5);
  });

  it('handles missing info gracefully', () => {
    const s = heuristicSuggest({});
    expect(VALID_TEMPLATES).toContain(s.template);
    expect(s.source).toBe('heuristic');
  });
});

// ---- buildSuggestionPrompt ----

describe('buildSuggestionPrompt', () => {
  it('includes project metadata', () => {
    const p = buildSuggestionPrompt({
      name: 'cars_control',
      stack: 'node',
      score: 6,
      recentCommits: 5,
      lastCommitDays: 2,
      checks: { hasClaude: true, hasTests: false, hasGitignore: true, gitClean: true, depsOk: null },
      readme: 'Some project readme',
      packageManifest: { name: 'cars_control', scripts: { test: 'vitest', build: 'tsc' } },
    });
    expect(p).toContain('cars_control');
    expect(p).toContain('node');
    expect(p).toContain('CLAUDE.md:✓');
    expect(p).toContain('tests:✗');
    expect(p).toContain('scripts: test, build');
    expect(p).toContain('Some project readme');
  });

  it('truncates README to first 800 chars', () => {
    const long = 'x'.repeat(2000);
    const prompt = buildSuggestionPrompt({ readme: long });
    // The README section should contain at most ~800 chars
    const section = prompt.split('### README')[1] || '';
    expect(section.length).toBeLessThan(1000);
  });

  it('handles missing fields', () => {
    const prompt = buildSuggestionPrompt({});
    expect(prompt).toContain('?');
    expect(prompt).toContain('(sin README)');
  });
});

// ---- parseSuggestion ----

describe('parseSuggestion', () => {
  it('parses clean JSON', () => {
    const r = parseSuggestion('{"template":"production-ready","note":"prio rendimiento","confidence":0.9,"reasoning":"OK"}');
    expect(r.template).toBe('production-ready');
    expect(r.note).toBe('prio rendimiento');
    expect(r.confidence).toBe(0.9);
    expect(r.source).toBe('llm');
  });

  it('strips markdown fences', () => {
    const r = parseSuggestion('```json\n{"template":"mantenimiento","confidence":0.7,"reasoning":"r"}\n```');
    expect(r.template).toBe('mantenimiento');
  });

  it('extracts JSON from preamble', () => {
    const r = parseSuggestion('Aquí mi respuesta:\n{"template":"MVP-lanzable","confidence":0.6,"reasoning":"r"}\nFin.');
    expect(r.template).toBe('MVP-lanzable');
  });

  it('clamps confidence to [0,1]', () => {
    expect(parseSuggestion('{"template":"MVP-lanzable","confidence":1.5,"reasoning":"r"}').confidence).toBe(1);
    expect(parseSuggestion('{"template":"MVP-lanzable","confidence":-0.5,"reasoning":"r"}').confidence).toBe(0);
  });

  it('falls back on invalid template', () => {
    const r = parseSuggestion('{"template":"nope","confidence":0.8,"reasoning":"r"}');
    expect(r.template).toBe('MVP-lanzable');
    expect(r.confidence).toBe(0.2);
  });

  it('falls back on malformed JSON', () => {
    expect(parseSuggestion('not json').template).toBe('MVP-lanzable');
    expect(parseSuggestion('{"unbalanced":').template).toBe('MVP-lanzable');
    expect(parseSuggestion('').template).toBe('MVP-lanzable');
  });

  it('defaults note to empty string if missing', () => {
    const r = parseSuggestion('{"template":"MVP-lanzable","confidence":0.8,"reasoning":"r"}');
    expect(r.note).toBe('');
  });
});

// ---- suggest (DI) ----

describe('suggest (with DI)', () => {
  it('returns heuristic when confidence is high enough', async () => {
    const info = {
      readme: 'API pública con autenticación',
      score: 7,
    };
    const invoked = [];
    const r = await suggest(info, {
      invoke: async (...args) => { invoked.push(args); return '{"template":"explorar-idea","confidence":0.9,"reasoning":"r"}'; },
    });
    expect(r.source).toBe('heuristic');
    expect(r.template).toBe('seguro-y-testeado');
    expect(invoked).toHaveLength(0);
  });

  it('falls back to LLM when heuristic is low-confidence', async () => {
    const info = {
      score: 5,
      checks: { hasClaude: true, hasTests: true },
      recentCommits: 0,
      lastCommitDays: 10,
    };
    const invoke = async () => '{"template":"production-ready","note":"revisar coverage","confidence":0.85,"reasoning":"LLM dice producción"}';
    const r = await suggest(info, { invoke });
    expect(r.source).toBe('llm');
    expect(r.template).toBe('production-ready');
  });

  it('alwaysLLM flag bypasses heuristic', async () => {
    const info = { readme: 'API pública con auth', score: 7 };
    let calls = 0;
    const invoke = async () => { calls++; return '{"template":"mantenimiento","confidence":0.9,"reasoning":"r"}'; };
    const r = await suggest(info, { alwaysLLM: true, invoke });
    expect(calls).toBe(1);
    expect(r.source).toBe('llm');
  });

  it('returns heuristic when LLM confidence < heuristic confidence', async () => {
    const info = { score: 5, checks: {}, recentCommits: 0 };
    const heur = heuristicSuggest(info);
    const invoke = async () => `{"template":"explorar-idea","confidence":${heur.confidence - 0.1},"reasoning":"r"}`;
    const r = await suggest(info, { invoke });
    // Heurística gana
    expect(r.source).toBe('heuristic');
  });

  it('uses heuristic as fallback when LLM throws', async () => {
    const info = {
      score: 5,
      checks: { hasClaude: true, hasTests: true },
      recentCommits: 0,
      lastCommitDays: 5,
    };
    const r = await suggest(info, {
      invoke: async () => { throw new Error('network'); },
    });
    expect(r.source).toBe('heuristic');
    expect(r.reasoning).toMatch(/LLM fall/);
  });
});
