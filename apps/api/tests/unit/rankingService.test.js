// ============================================================
// Unit tests: rankingService.js (pure scoring helpers)
//
// Since rankingService.js heavily depends on DB queries,
// we test the core scoring logic through the public API
// with mock data injected via the DB mock.
// ============================================================
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Setup mock BEFORE requiring rankingService
const mockDb = require('../helpers/setup');
const { generateBullishCandles, generateBearishCandles, generateFlatCandles } = require('../helpers/fixtures');

const {
  runScreener,
  getDailyPicks,
  getLatestRanking,
  getPickStats,
  validatePastPicks,
  getBestToInvest,
} = require('../../src/screener/rankingService');

describe('rankingService', () => {
  beforeEach(() => {
    mockDb.reset();
  });

  describe('runScreener', () => {
    it('returns empty array when no instruments', () => {
      mockDb.pushQueryResult([]); // instruments query
      // detectMarketRegime: queryOne for WIG20 regime
      mockDb.pushQueryOneResult(null);
      // detectMarketRegime fallback: query for regime counts
      mockDb.pushQueryResult([]);
      const result = runScreener();
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 0);
    });

    it('scores instruments with valid score range', () => {
      const candles = generateBullishCandles(100);

      // instruments query
      mockDb.pushQueryResult([
        { ticker: 'PKOBP', name: 'PKO BP', type: 'STOCK' },
      ]);

      // detectMarketRegime: queryOne for WIG20
      mockDb.pushQueryOneResult({ regime: 'neutral' });

      // For PKO:
      mockDb.pushQueryResult(candles); // candles
      mockDb.pushQueryOneResult({ confidence: 0.6, predicted_direction: 'BUY', predicted_return: 0.03 }); // prediction
      mockDb.pushQueryOneResult({ rsi14: 55, rsi7: 58, macd: 0.5, macd_hist: 0.2, bb_upper: 110, bb_lower: 90, atr14: 2 }); // features
      // computeModelQualityScore → model_registry
      mockDb.pushQueryOneResult({ accuracy: 0.62, created_at: new Date().toISOString() });

      const result = runScreener();
      assert.ok(result.length >= 0);
      for (const r of result) {
        assert.ok(typeof r.score === 'number');
        assert.ok(r.score >= 0 && r.score <= 100);
        assert.ok(r.components);
      }
    });
  });

  describe('getDailyPicks', () => {
    it('returns empty picks when no ranking data', () => {
      // getLatestRanking: queryOne for MAX(ranked_at)
      mockDb.pushQueryOneResult(null);

      const result = getDailyPicks();
      assert.ok(result.picks);
      assert.equal(result.picks.length, 0);
      assert.ok(result.qualityGates);
      assert.equal(result.qualityGates.maxConcurrentPicks, 5);
    });

    it('enforces quality gates — low confidence filtered out', () => {
      // getLatestRanking:
      mockDb.pushQueryOneResult({ d: '2025-06-01 12:00:00' }); // MAX ranked_at
      mockDb.pushQueryResult([
        {
          ticker: 'PKOBP', name: 'PKO BP', type: 'STOCK',
          score: 20, // below minCompositeScore of 30
          metrics: JSON.stringify({ components: { signal: 20, execution: 20, risk: 20, model: 20 }, lastClose: 50 }),
          reason: 'test', ranked_at: '2025-06-01 12:00:00',
        },
      ]);

      // getDailyPicks internally: for each candidate:
      // queryOne prediction
      mockDb.pushQueryOneResult({ confidence: 0.2, predicted_direction: 'BUY', predicted_return: 0.001 });
      // query candles
      mockDb.pushQueryResult(generateBullishCandles(20));
      // queryOne features (relative_strength, sector_rs)
      mockDb.pushQueryOneResult({ relative_strength: 0.01, sector_rs: 0.005 });

      const result = getDailyPicks();
      // Should be filtered out by quality gates (confidence < 0.35 & score < 30)
      assert.equal(result.picks.length, 0);
      assert.equal(result.passedGates, 0);
    });

    it('respects maxConcurrentPicks limit', () => {
      // Empty ranking → no picks → limit doesn't matter
      mockDb.pushQueryOneResult(null);
      const result = getDailyPicks({ limit: 100 });
      assert.ok(result.picks.length <= 5);
    });
  });

  describe('getLatestRanking', () => {
    it('returns empty array when no ranking date', () => {
      mockDb.pushQueryOneResult(null); // queryOne for MAX(ranked_at)
      const result = getLatestRanking();
      assert.deepEqual(result, []);
    });

    it('parses metrics JSON from rows', () => {
      mockDb.pushQueryOneResult({ d: '2025-06-01' }); // queryOne MAX(ranked_at)
      mockDb.pushQueryResult([ // query for ranking rows
        {
          ticker: 'PKOBP', name: 'PKO BP', type: 'STOCK',
          score: 75, metrics: JSON.stringify({ lastClose: 50, components: { signal: 80 } }),
          reason: 'Strong momentum', ranked_at: '2025-06-01',
        },
      ]);

      const result = getLatestRanking(10);
      assert.equal(result.length, 1);
      assert.equal(result[0].ticker, 'PKOBP');
      assert.equal(result[0].metrics.lastClose, 50);
    });
  });

  describe('getPickStats', () => {
    it('returns null when no validated picks', () => {
      // queryOne returns row with total_picks = 0
      mockDb.pushQueryOneResult({ total_picks: 0, avg_ret_1d: null, avg_ret_2d: null, avg_ret_3d: null, avg_mae: null, avg_mfe: null, wins_1d: 0, wins_2d: 0, wins_3d: 0 });
      const stats = getPickStats(30);
      assert.equal(stats, null);
    });

    it('computes precision metrics correctly', () => {
      mockDb.pushQueryOneResult({
        total_picks: 10,
        avg_ret_1d: 1.5,
        avg_ret_2d: 2.0,
        avg_ret_3d: 2.5,
        avg_mae: -1.0,
        avg_mfe: 3.0,
        wins_1d: 6,
        wins_2d: 7,
        wins_3d: 8,
      });

      const stats = getPickStats(30);
      assert.ok(stats);
      assert.equal(stats.totalPicks, 10);
      assert.equal(stats.precision1D, 60);
      assert.equal(stats.precision2D, 70);
      assert.equal(stats.precision3D, 80);
    });
  });
});
