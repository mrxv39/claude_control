import { describe, it, expect } from 'vitest';

/**
 * Tests for statusline-writer.js logic.
 *
 * statusline-writer.js reads JSON from stdin, transforms it into a compact
 * format for claudio_control, and prints a status line to stdout.
 * We test the transformation and formatting logic.
 */

// --- Transform logic (mirrored from statusline-writer.js:27-59) ---
function transformInput(data) {
  const rl = data.rate_limits || {};
  const fh = rl.five_hour || {};
  const sd = rl.seven_day || {};
  const ctx = data.context_window || {};
  const cost = data.cost || {};

  return {
    fiveHour: {
      usedPercent: fh.used_percentage || 0,
      resetsAt: fh.resets_at || 0,
    },
    sevenDay: {
      usedPercent: sd.used_percentage || 0,
      resetsAt: sd.resets_at || 0,
    },
    contextWindow: {
      usedPercent: ctx.used_percentage || 0,
      totalInput: ctx.total_input_tokens || 0,
      totalOutput: ctx.total_output_tokens || 0,
      size: ctx.context_window_size || 0,
    },
    cost: {
      totalUsd: cost.total_cost_usd || 0,
      linesAdded: cost.total_lines_added || 0,
      linesRemoved: cost.total_lines_removed || 0,
    },
    sessionId: data.session_id || '',
    cwd: data.cwd || '',
    model: (data.model && data.model.display_name) || '',
  };
}

// --- Status line formatting (mirrored from statusline-writer.js:65-73) ---
function formatStatusLine(data) {
  const rl = data.rate_limits || {};
  const fh = rl.five_hour || {};
  const cost = data.cost || {};
  const sd = rl.seven_day || {};

  const pct5 = fh.used_percentage || 0;
  const pct7 = sd.used_percentage || 0;
  const resetMs = (fh.resets_at || 0) * 1000 - Date.now();
  const resetMin = Math.max(0, Math.round(resetMs / 60000));
  const resetStr = resetMin > 60
    ? `${Math.floor(resetMin / 60)}h${resetMin % 60}m`
    : `${resetMin}m`;
  const costStr = cost.total_cost_usd ? ` $${cost.total_cost_usd.toFixed(2)}` : '';

  const bar = pct5 < 50 ? '\u{1F7E2}' : pct5 < 80 ? '\u{1F7E1}' : '\u{1F534}';
  return `${bar} 5h:${pct5}% (${resetStr}) 7d:${pct7}%${costStr}`;
}


describe('statusline-writer transformInput', () => {
  it('should transform full input correctly', () => {
    const input = {
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: 1713400000 },
        seven_day: { used_percentage: 15, resets_at: 1713900000 },
      },
      context_window: {
        used_percentage: 30,
        total_input_tokens: 50000,
        total_output_tokens: 10000,
        context_window_size: 200000,
      },
      cost: {
        total_cost_usd: 1.25,
        total_lines_added: 100,
        total_lines_removed: 20,
      },
      session_id: 'sess-123',
      cwd: '/home/user/project',
      model: { display_name: 'Claude Opus 4' },
    };

    const result = transformInput(input);

    expect(result.fiveHour.usedPercent).toBe(42);
    expect(result.sevenDay.usedPercent).toBe(15);
    expect(result.contextWindow.usedPercent).toBe(30);
    expect(result.contextWindow.totalInput).toBe(50000);
    expect(result.cost.totalUsd).toBe(1.25);
    expect(result.cost.linesAdded).toBe(100);
    expect(result.sessionId).toBe('sess-123');
    expect(result.cwd).toBe('/home/user/project');
    expect(result.model).toBe('Claude Opus 4');
  });

  it('should handle empty input with all defaults', () => {
    const result = transformInput({});

    expect(result.fiveHour.usedPercent).toBe(0);
    expect(result.fiveHour.resetsAt).toBe(0);
    expect(result.sevenDay.usedPercent).toBe(0);
    expect(result.contextWindow.usedPercent).toBe(0);
    expect(result.contextWindow.size).toBe(0);
    expect(result.cost.totalUsd).toBe(0);
    expect(result.sessionId).toBe('');
    expect(result.cwd).toBe('');
    expect(result.model).toBe('');
  });

  it('should handle missing nested objects', () => {
    const result = transformInput({
      rate_limits: {},
      session_id: 'test',
    });

    expect(result.fiveHour.usedPercent).toBe(0);
    expect(result.sevenDay.usedPercent).toBe(0);
    expect(result.sessionId).toBe('test');
  });

  it('should handle missing model display_name', () => {
    expect(transformInput({ model: {} }).model).toBe('');
    expect(transformInput({ model: null }).model).toBe('');
    expect(transformInput({}).model).toBe('');
  });

  it('should preserve zero values correctly', () => {
    const result = transformInput({
      rate_limits: {
        five_hour: { used_percentage: 0, resets_at: 0 },
      },
      cost: { total_cost_usd: 0 },
    });
    expect(result.fiveHour.usedPercent).toBe(0);
    expect(result.cost.totalUsd).toBe(0);
  });
});

describe('statusline-writer formatStatusLine', () => {
  it('should show green emoji for low usage', () => {
    const line = formatStatusLine({
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 0 },
        seven_day: { used_percentage: 5 },
      },
    });
    expect(line).toContain('\u{1F7E2}'); // green circle
    expect(line).toContain('5h:10%');
    expect(line).toContain('7d:5%');
  });

  it('should show yellow emoji for moderate usage', () => {
    const line = formatStatusLine({
      rate_limits: {
        five_hour: { used_percentage: 60, resets_at: 0 },
        seven_day: { used_percentage: 20 },
      },
    });
    expect(line).toContain('\u{1F7E1}'); // yellow circle
  });

  it('should show red emoji for high usage', () => {
    const line = formatStatusLine({
      rate_limits: {
        five_hour: { used_percentage: 85, resets_at: 0 },
        seven_day: { used_percentage: 30 },
      },
    });
    expect(line).toContain('\u{1F534}'); // red circle
  });

  it('should show cost when present', () => {
    const line = formatStatusLine({
      rate_limits: { five_hour: { used_percentage: 10 } },
      cost: { total_cost_usd: 3.50 },
    });
    expect(line).toContain('$3.50');
  });

  it('should omit cost when zero', () => {
    const line = formatStatusLine({
      rate_limits: { five_hour: { used_percentage: 10 } },
      cost: { total_cost_usd: 0 },
    });
    expect(line).not.toContain('$');
  });

  it('should omit cost when missing', () => {
    const line = formatStatusLine({
      rate_limits: { five_hour: { used_percentage: 10 } },
    });
    expect(line).not.toContain('$');
  });

  it('should format reset time in minutes when under 1h', () => {
    const now = Date.now();
    const resetAt = (now + 30 * 60000) / 1000; // 30 min from now
    const line = formatStatusLine({
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: resetAt },
      },
    });
    expect(line).toMatch(/\(\d+m\)/);
    // The parenthesized time should NOT contain 'h' (no hours)
    const timeMatch = line.match(/\(([^)]+)\)/);
    expect(timeMatch[1]).not.toContain('h');
  });

  it('should format reset time with hours when over 1h', () => {
    const now = Date.now();
    const resetAt = (now + 150 * 60000) / 1000; // 2.5h from now
    const line = formatStatusLine({
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: resetAt },
      },
    });
    expect(line).toMatch(/\d+h\d+m/);
  });

  it('should clamp negative reset to 0m', () => {
    const line = formatStatusLine({
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 0 },
      },
    });
    expect(line).toContain('(0m)');
  });

  it('should handle completely empty input', () => {
    const line = formatStatusLine({});
    expect(line).toContain('5h:0%');
    expect(line).toContain('7d:0%');
    expect(line).toContain('\u{1F7E2}'); // green for 0%
  });

  it('boundary: exactly 50% should be yellow', () => {
    const line = formatStatusLine({
      rate_limits: { five_hour: { used_percentage: 50 } },
    });
    expect(line).toContain('\u{1F7E1}');
  });

  it('boundary: exactly 80% should be red', () => {
    const line = formatStatusLine({
      rate_limits: { five_hour: { used_percentage: 80 } },
    });
    expect(line).toContain('\u{1F534}');
  });

  it('boundary: 49% should be green', () => {
    const line = formatStatusLine({
      rate_limits: { five_hour: { used_percentage: 49 } },
    });
    expect(line).toContain('\u{1F7E2}');
  });

  it('boundary: 79% should be yellow', () => {
    const line = formatStatusLine({
      rate_limits: { five_hour: { used_percentage: 79 } },
    });
    expect(line).toContain('\u{1F7E1}');
  });
});
