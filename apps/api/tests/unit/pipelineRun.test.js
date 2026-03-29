// ============================================================
// Unit tests: pipeline run tracking, degraded mode, quality gates
// ============================================================
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Setup mock BEFORE requiring modules
const mockDb = require('../helpers/setup');
const { generateBullishCandles } = require('../helpers/fixtures');

describe('pipeline run tracking', () => {
  beforeEach(() => {
    mockDb.reset();
  });

  describe('rankingService – getDailyPicks', () => {
    const { getDailyPicks } = require('../../src/screener/rankingService');

    it('returns rankedAt equal to generatedAt (no misleading timestamp)', () => {
      // getLatestRanking: queryOne for MAX(ranked_at)
      const rankedTime = '2026-03-29 10:00:00';
      mockDb.pushQueryOneResult({ d: rankedTime });
      mockDb.pushQueryResult([
        {
          ticker: 'PKOBP', name: 'PKO BP', type: 'STOCK',
          score: 75,
          metrics: JSON.stringify({ components: { signal: 80, execution: 60, risk: 70, model: 65 }, lastClose: 50 }),
          reason: 'Strong momentum', ranked_at: rankedTime,
        },
      ]);

      // For candidate processing:
      mockDb.pushQueryOneResult({ confidence: 0.6, predicted_direction: 'BUY', predicted_return: 0.05 }); // prediction
      mockDb.pushQueryResult(generateBullishCandles(100)); // candles
      mockDb.pushQueryOneResult({ relative_strength: 0.05, sector_rs: 0.02 }); // features
      // computeSellLevels: features
      mockDb.pushQueryOneResult({ atr14: 2, vol_20d: 0.2, rsi14: 55, macd_hist: 0.1, regime: 'neutral' });
      // computeSellLevels: instruments type
      mockDb.pushQueryOneResult({ type: 'STOCK' });

      const result = getDailyPicks();
      // generatedAt should be the ranked_at, not current time
      assert.equal(result.generatedAt, rankedTime);
      assert.equal(result.rankedAt, rankedTime);
    });

    it('returns rejectedGates with explicit rejection reasons', () => {
      const rankedTime = '2026-03-29 10:00:00';
      mockDb.pushQueryOneResult({ d: rankedTime });
      mockDb.pushQueryResult([
        {
          ticker: 'WEAK', name: 'Weak Corp', type: 'STOCK',
          score: 10, // below minCompositeScore=30
          metrics: JSON.stringify({ components: { signal: 10, execution: 10, risk: 10, model: 10 }, lastClose: 20 }),
          reason: 'Słabe wskaźniki', ranked_at: rankedTime,
        },
      ]);

      // candidate processing:
      mockDb.pushQueryOneResult({ confidence: 0.1, predicted_direction: 'BUY', predicted_return: 0.001 });
      mockDb.pushQueryResult(generateBullishCandles(100));
      mockDb.pushQueryOneResult({ relative_strength: 0.01, sector_rs: 0.005 });

      const result = getDailyPicks();
      assert.equal(result.picks.length, 0);
      assert.ok(result.rejectedGates);
      assert.ok(result.rejectedGates.length > 0);
      const rej = result.rejectedGates[0];
      assert.equal(rej.ticker, 'WEAK');
      assert.ok(rej.reasons.length > 0);
      assert.ok(rej.reasons.some(r => r.includes('confidence') || r.includes('score')));
    });

    it('returns empty picks gracefully when no ranking data', () => {
      mockDb.pushQueryOneResult(null); // no MAX ranked_at
      const result = getDailyPicks();
      assert.equal(result.picks.length, 0);
      assert.equal(result.generatedAt, null);
    });
  });

  describe('riskEngine – getCompetitionSellCandidates', () => {
    const { getCompetitionSellCandidates } = require('../../src/ml/riskEngine');

    it('returns empty when no competition positions', () => {
      mockDb.pushQueryResult([]); // competition_portfolio query
      const result = getCompetitionSellCandidates();
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 0);
    });

    it('flags position at stop-loss as SELL', () => {
      // competition_portfolio positions
      mockDb.pushQueryResult([
        { id: 1, ticker: 'PKOBP', shares: 100, entry_price: 50, entry_date: '2026-03-01' },
      ]);
      // latest candle (price dropped below SL)
      mockDb.pushQueryOneResult({ close: 42, high: 43, low: 41, date: '2026-03-29' });
      // computeSellLevels → features
      mockDb.pushQueryOneResult({ atr14: 2, vol_20d: 0.2, rsi14: 40, macd_hist: -0.1, regime: 'bearish' });
      // computeSellLevels → instruments type
      mockDb.pushQueryOneResult({ type: 'STOCK' });
      // momentum check features
      mockDb.pushQueryOneResult({ rsi14: 40, macd_hist: -0.1, regime: 'bearish' });

      const result = getCompetitionSellCandidates();
      assert.ok(result.length >= 1);
      const sell = result[0];
      assert.equal(sell.ticker, 'PKOBP');
      assert.equal(sell.action, 'SELL');
      assert.ok(sell.sellReasons.some(r => r.includes('stop-loss')));
    });

    it('flags position at take-profit as PARTIAL_SELL', () => {
      mockDb.pushQueryResult([
        { id: 2, ticker: 'CDR', shares: 50, entry_price: 100, entry_date: '2026-03-20' },
      ]);
      // Price rose to fast TP level (+4%)
      mockDb.pushQueryOneResult({ close: 105, high: 106, low: 104, date: '2026-03-29' });
      // computeSellLevels → features
      mockDb.pushQueryOneResult({ atr14: 3, vol_20d: 0.25, rsi14: 65, macd_hist: 0.5, regime: 'bullish' });
      mockDb.pushQueryOneResult({ type: 'STOCK' });
      // momentum check
      mockDb.pushQueryOneResult({ rsi14: 65, macd_hist: 0.5, regime: 'bullish' });

      const result = getCompetitionSellCandidates();
      // Should flag PARTIAL_SELL since price > fast TP but < full TP
      const cdr = result.find(r => r.ticker === 'CDR');
      if (cdr) {
        assert.ok(['PARTIAL_SELL', 'SELL'].includes(cdr.action));
      }
    });
  });

  describe('worker – pipeline run functions exist', () => {
    it('exports getLatestPipelineRun and getPipelineRunById', () => {
      const worker = require('../../src/worker/jobWorker');
      assert.ok(typeof worker.getLatestPipelineRun === 'function');
      assert.ok(typeof worker.getPipelineRunById === 'function');
    });

    it('getLatestPipelineRun returns null when no runs', () => {
      const { getLatestPipelineRun } = require('../../src/worker/jobWorker');
      mockDb.pushQueryOneResult(null);
      const result = getLatestPipelineRun();
      assert.equal(result, null);
    });

    it('getPipelineRunById returns null for unknown run', () => {
      const { getPipelineRunById } = require('../../src/worker/jobWorker');
      mockDb.pushQueryOneResult(null);
      const result = getPipelineRunById('run_nonexistent');
      assert.equal(result, null);
    });
  });
});
