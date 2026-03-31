// ============================================================
// Unit tests: topGainersT1.js – T+1 ranking model
// ============================================================
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Setup mock BEFORE requiring modules
const mockDb = require('../helpers/setup');
const { generateBullishCandles, generateBearishCandles } = require('../helpers/fixtures');

const { trainT1Model, predictTopGainersT1, validateT1Predictions, getLatestTopGainersT1, loadT1Model } = require('../../src/ml/topGainersT1');

describe('topGainersT1', () => {
  beforeEach(() => {
    mockDb.reset();
  });

  describe('trainT1Model', () => {
    it('returns null with insufficient data', () => {
      // instruments query
      mockDb.pushQueryResult([{ ticker: 'PKO' }, { ticker: 'CDR' }]);
      // feature rows for PKO
      mockDb.pushQueryResult([]);
      // feature rows for CDR
      mockDb.pushQueryResult([]);

      const result = trainT1Model({ lookback: 50 });
      assert.equal(result, null);
    });

    it('trains model when sufficient cross-sectional data exists', () => {
      // Build mock cross-sectional dataset: 5 tickers × 80 dates
      const tickers = ['PKO', 'CDR', 'KGH', 'PEO', 'MBK'];
      // instruments query
      mockDb.pushQueryResult(tickers.map(t => ({ ticker: t })));

      for (const ticker of tickers) {
        const rows = [];
        for (let d = 0; d < 80; d++) {
          const date = `2025-${String(Math.floor(d / 30) + 1).padStart(2, '0')}-${String((d % 28) + 1).padStart(2, '0')}`;
          const price = 50 + Math.random() * 50;
          rows.push({
            ticker,
            date,
            rsi14: 40 + Math.random() * 30,
            rsi7: 40 + Math.random() * 30,
            macd: (Math.random() - 0.5) * 2,
            macd_hist: (Math.random() - 0.5) * 1,
            sma20: price, sma50: price * 0.98, sma200: price * 0.95,
            bb_upper: price * 1.05, bb_lower: price * 0.95,
            vol_20d: 0.2 + Math.random() * 0.2,
            atr14: price * 0.02,
            momentum_1m: (Math.random() - 0.5) * 0.1,
            momentum_5d: (Math.random() - 0.5) * 0.05,
            momentum_10d: (Math.random() - 0.5) * 0.08,
            volume_ratio: 0.5 + Math.random() * 2,
            vol_accel: 0.8 + Math.random() * 0.4,
            gap_pct: (Math.random() - 0.5) * 0.02,
            range_expansion: 0.5 + Math.random(),
            close_position: Math.random(),
            upper_shadow_pct: Math.random() * 0.3,
            body_pct: 0.3 + Math.random() * 0.5,
            mom1d_rank: Math.random(),
            vol_rank: Math.random(),
            rs_rank: Math.random(),
            relative_strength: (Math.random() - 0.5) * 0.05,
            sector_rs: (Math.random() - 0.5) * 0.05,
            regime: 'neutral',
            max_dd_60d: Math.random() * 0.1,
            vwap_proxy: price,
            pivot_pp: price, pivot_r1: price * 1.02, pivot_s1: price * 0.98,
            current_close: price,
            future_close: price * (1 + (Math.random() - 0.4) * 0.06),
          });
        }
        mockDb.pushQueryResult(rows);
      }

      const result = trainT1Model({ lookback: 80 });
      assert.ok(result, 'Should return training result');
      assert.ok(result.samples > 0, `samples=${result.samples}`);
      assert.ok(result.precision5 >= 0, `precision5=${result.precision5}`);
    });
  });

  describe('getLatestTopGainersT1', () => {
    it('returns empty when no predictions exist', () => {
      mockDb.pushQueryOneResult(null); // no MAX(prediction_date)
      const data = getLatestTopGainersT1(5);
      assert.deepEqual(data.predictions, []);
      assert.equal(data.predictionDate, null);
    });

    it('returns predictions when available', () => {
      mockDb.pushQueryOneResult({ d: '2025-06-15' });
      mockDb.pushQueryResult([
        { ticker: 'PKO', rank: 1, predicted_return_1d: 3.5, top5_probability: 72, name: 'PKO BP', type: 'STOCK' },
        { ticker: 'CDR', rank: 2, predicted_return_1d: 2.8, top5_probability: 65, name: 'CD Projekt', type: 'STOCK' },
      ]);
      const data = getLatestTopGainersT1(5);
      assert.equal(data.predictionDate, '2025-06-15');
      assert.equal(data.predictions.length, 2);
      assert.equal(data.predictions[0].ticker, 'PKO');
    });
  });

  describe('validateT1Predictions', () => {
    it('returns 0 when nothing to validate', () => {
      mockDb.pushQueryResult([]); // no unvalidated rows
      const result = validateT1Predictions();
      assert.equal(result.validated, 0);
    });
  });

  describe('loadT1Model', () => {
    it('returns false when no model in registry', () => {
      mockDb.pushQueryOneResult(null);
      const loaded = loadT1Model();
      assert.equal(loaded, false);
    });
  });
});
