#!/usr/bin/env node
/**
 * statusline-writer.js — Claude Code statusLine hook.
 *
 * Claude Code calls this on each status refresh, passing JSON on stdin with
 * rate_limits, context_window, cost, model, session_id data.
 * We write it to a shared file for claudio_control to read,
 * and print a compact status line for the terminal.
 *
 * Configure in ~/.claude/settings.json:
 *   "statusLine": { "type": "command", "command": "node <path>", "refreshInterval": 10000 }
 *
 * Output (stdout): compact status line for terminal display
 * Side effect: writes rate-limits.json to ~/.claude/claudio-state/
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'claudio-state');
const OUTPUT_PATH = path.join(STATE_DIR, 'rate-limits.json');
let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const rl = data.rate_limits || {};
    const fh = rl.five_hour || {};
    const sd = rl.seven_day || {};
    const ctx = data.context_window || {};
    const cost = data.cost || {};

    // Write to shared file for claudio_control
    const output = {
      fiveHour: {
        usedPercent: fh.used_percentage || 0,
        resetsAt: fh.resets_at || 0
      },
      sevenDay: {
        usedPercent: sd.used_percentage || 0,
        resetsAt: sd.resets_at || 0
      },
      contextWindow: {
        usedPercent: ctx.used_percentage || 0,
        totalInput: ctx.total_input_tokens || 0,
        totalOutput: ctx.total_output_tokens || 0,
        size: ctx.context_window_size || 0
      },
      cost: {
        totalUsd: cost.total_cost_usd || 0,
        linesAdded: cost.total_lines_added || 0,
        linesRemoved: cost.total_lines_removed || 0
      },
      sessionId: data.session_id || '',
      cwd: data.cwd || '',
      model: (data.model && data.model.display_name) || '',
      updatedAt: Date.now()
    };

    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output), 'utf-8');

    // Print compact status line for terminal
    const pct5 = fh.used_percentage || 0;
    const pct7 = sd.used_percentage || 0;
    const resetMs = (fh.resets_at || 0) * 1000 - Date.now();
    const resetMin = Math.max(0, Math.round(resetMs / 60000));
    const resetStr = resetMin > 60 ? `${Math.floor(resetMin / 60)}h${resetMin % 60}m` : `${resetMin}m`;
    const costStr = cost.total_cost_usd ? ` $${cost.total_cost_usd.toFixed(2)}` : '';

    const bar = pct5 < 50 ? '🟢' : pct5 < 80 ? '🟡' : '🔴';
    process.stdout.write(`${bar} 5h:${pct5}% (${resetStr}) 7d:${pct7}%${costStr}`);
  } catch (e) {
    process.stdout.write('⚙ claudio');
  }
});
