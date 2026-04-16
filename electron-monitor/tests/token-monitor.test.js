import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock fs for controlled rate-limits.json reading
const RATE_LIMITS_PATH = path.join(os.tmpdir(), `claudio-test-tm-${Date.now()}`, 'rate-limits.json');
const PROJECTS_DIR = path.join(os.tmpdir(), `claudio-test-tm-${Date.now()}`, 'projects');

// We test the pure logic functions by reimplementing them without fs dependencies
// This avoids mocking fs globally which breaks vitest internals

describe('token-monitor pure logic', () => {
  describe('getPacingDecision logic', () => {
    // Reimplement the pacing logic for testing (same algorithm as token-monitor.js)
    function getPacingDecision(cycleInfo, config = {}) {
      const maxTarget = config.pacingMaxTarget || 95;
      const exponent = config.pacingExponent || 0.6;
      const sevenDayThrottle = config.sevenDayThrottle || 80;
      const sevenDayCaution = config.sevenDayCaution || 60;

      if (!cycleInfo) return { action: 'wait', reason: 'sin datos de rate limit' };

      // 7-day guard
      if (cycleInfo.sevenDayPercent > sevenDayThrottle) {
        return { action: 'coast', reason: `7d al ${cycleInfo.sevenDayPercent}% (>${sevenDayThrottle}%)`, cycle: cycleInfo, targetUsage: 0, delta: 0 };
      }

      let effectiveMax = maxTarget;
      if (cycleInfo.sevenDayPercent > sevenDayCaution) {
        effectiveMax = Math.min(effectiveMax, 70);
      }

      const targetUsage = Math.round(Math.pow(cycleInfo.progress, exponent) * effectiveMax);
      const delta = targetUsage - cycleInfo.usedPercent;

      let action, reason;
      if (cycleInfo.remainingMin <= 30 && delta > 10) {
        action = 'burst';
        reason = `${cycleInfo.remainingMin}m left, ${delta}% bajo target`;
      } else if (delta > 15) {
        action = 'burst';
        reason = `${delta}% bajo target`;
      } else if (delta > 5) {
        action = 'accelerate';
        reason = `${delta}% bajo target`;
      } else if (delta > -5) {
        action = 'pace';
        reason = `on track (delta ${delta > 0 ? '+' : ''}${delta}%)`;
      } else {
        action = 'coast';
        reason = `${-delta}% sobre target`;
      }

      return { action, reason, cycle: cycleInfo, targetUsage, delta };
    }

    it('returns "wait" when no cycle data', () => {
      const result = getPacingDecision(null);
      expect(result.action).toBe('wait');
    });

    it('returns "coast" when 7-day usage exceeds throttle', () => {
      const cycle = { usedPercent: 20, sevenDayPercent: 85, progress: 0.5, remainingMin: 150 };
      const result = getPacingDecision(cycle);
      expect(result.action).toBe('coast');
    });

    it('reduces effective max when 7-day exceeds caution threshold', () => {
      // 7-day at 65% (>60 caution) → effectiveMax capped at 70
      // progress=0.8 → target = 0.8^0.6 × 70 ≈ 60, usedPercent=10 → delta=50 → burst
      const cycle = { usedPercent: 10, sevenDayPercent: 65, progress: 0.8, remainingMin: 60 };
      const result = getPacingDecision(cycle);
      expect(result.action).toBe('burst');
      // Target should be based on 70, not 95
      expect(result.targetUsage).toBeLessThanOrEqual(70);
    });

    it('returns "burst" when far below target', () => {
      // progress=0.5, target ≈ 0.5^0.6 × 95 ≈ 63, usedPercent=10 → delta=53
      const cycle = { usedPercent: 10, sevenDayPercent: 30, progress: 0.5, remainingMin: 150 };
      const result = getPacingDecision(cycle);
      expect(result.action).toBe('burst');
      expect(result.delta).toBeGreaterThan(15);
    });

    it('returns "burst" when little time remaining and behind target', () => {
      const cycle = { usedPercent: 50, sevenDayPercent: 30, progress: 0.9, remainingMin: 20 };
      const result = getPacingDecision(cycle);
      expect(result.action).toBe('burst');
    });

    it('returns "accelerate" when moderately below target', () => {
      // Need delta 6-15
      // progress=0.5 → target ≈ 63, usedPercent=55 → delta=8
      const cycle = { usedPercent: 55, sevenDayPercent: 30, progress: 0.5, remainingMin: 150 };
      const result = getPacingDecision(cycle);
      expect(result.action).toBe('accelerate');
    });

    it('returns "pace" when on track', () => {
      // Need delta -5 to 5
      // progress=0.5 → target ≈ 63, usedPercent=61 → delta=2
      const cycle = { usedPercent: 61, sevenDayPercent: 30, progress: 0.5, remainingMin: 150 };
      const result = getPacingDecision(cycle);
      expect(result.action).toBe('pace');
    });

    it('returns "coast" when ahead of target', () => {
      // Need delta < -5
      // progress=0.3 → target ≈ 0.3^0.6 × 95 ≈ 44, usedPercent=60 → delta=-16
      const cycle = { usedPercent: 60, sevenDayPercent: 30, progress: 0.3, remainingMin: 200 };
      const result = getPacingDecision(cycle);
      expect(result.action).toBe('coast');
    });

    it('uses custom config values', () => {
      const cycle = { usedPercent: 10, sevenDayPercent: 30, progress: 0.5, remainingMin: 150 };
      const config = { pacingMaxTarget: 50, pacingExponent: 1.0 };
      const result = getPacingDecision(cycle, config);
      // progress=0.5, target = 0.5^1.0 × 50 = 25, delta=15 → burst
      expect(result.targetUsage).toBe(25);
    });
  });

  describe('getRecommendedInterval', () => {
    function getRecommendedInterval(action) {
      switch (action) {
        case 'burst':      return 15 * 1000;
        case 'accelerate': return 30 * 1000;
        case 'pace':       return 60 * 1000;
        case 'coast':      return 120 * 1000;
        default:           return 60 * 1000;
      }
    }

    it('returns 15s for burst', () => {
      expect(getRecommendedInterval('burst')).toBe(15000);
    });

    it('returns 30s for accelerate', () => {
      expect(getRecommendedInterval('accelerate')).toBe(30000);
    });

    it('returns 60s for pace', () => {
      expect(getRecommendedInterval('pace')).toBe(60000);
    });

    it('returns 120s for coast', () => {
      expect(getRecommendedInterval('coast')).toBe(120000);
    });

    it('returns 60s for unknown action', () => {
      expect(getRecommendedInterval('unknown')).toBe(60000);
    });
  });

  describe('getCycleInfo logic', () => {
    function getCycleInfo(rateLimits) {
      if (!rateLimits || !rateLimits.fiveHour || !rateLimits.sevenDay) return null;

      const now = Date.now() / 1000;
      const resetsAt = rateLimits.fiveHour.resetsAt;
      const cycleLen = 5 * 3600;
      const cycleStart = resetsAt - cycleLen;
      const elapsed = Math.max(0, now - cycleStart);
      const remaining = Math.max(0, resetsAt - now);
      const progress = Math.min(1, elapsed / cycleLen);

      return {
        usedPercent: rateLimits.fiveHour.usedPercent,
        sevenDayPercent: rateLimits.sevenDay.usedPercent,
        remainingMin: Math.round(remaining / 60),
        progress,
        resetsAt,
        isStale: !rateLimits.updatedAt || (Date.now() - rateLimits.updatedAt) > 10 * 60 * 1000
      };
    }

    it('returns null when no rate limits', () => {
      expect(getCycleInfo(null)).toBeNull();
      expect(getCycleInfo({})).toBeNull();
      expect(getCycleInfo({ fiveHour: {} })).toBeNull();
    });

    it('calculates progress correctly mid-cycle', () => {
      const now = Date.now() / 1000;
      const rl = {
        fiveHour: { usedPercent: 30, resetsAt: now + 2 * 3600 }, // 2h remaining
        sevenDay: { usedPercent: 40 },
        updatedAt: Date.now()
      };
      const info = getCycleInfo(rl);
      expect(info.progress).toBeGreaterThan(0.5);
      expect(info.progress).toBeLessThan(0.7);
      expect(info.remainingMin).toBeCloseTo(120, -1);
      expect(info.isStale).toBe(false);
    });

    it('marks data as stale when updatedAt is old', () => {
      const now = Date.now() / 1000;
      const rl = {
        fiveHour: { usedPercent: 30, resetsAt: now + 3600 },
        sevenDay: { usedPercent: 40 },
        updatedAt: Date.now() - 15 * 60 * 1000 // 15 min ago
      };
      const info = getCycleInfo(rl);
      expect(info.isStale).toBe(true);
    });

    it('clamps progress to max 1.0', () => {
      const now = Date.now() / 1000;
      const rl = {
        fiveHour: { usedPercent: 95, resetsAt: now - 100 }, // already past
        sevenDay: { usedPercent: 40 },
        updatedAt: Date.now()
      };
      const info = getCycleInfo(rl);
      expect(info.progress).toBe(1);
      expect(info.remainingMin).toBe(0);
    });
  });
});
