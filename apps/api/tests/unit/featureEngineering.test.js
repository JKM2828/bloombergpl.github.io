// ============================================================
// Unit tests: featureEngineering.js (pure computation)
//
// Since featureEngineering.js depends on DB + shared indicators,
// we test computeFeatures via mock and verify feature structure.
// ============================================================
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Setup mock BEFORE requiring featureEngineering
const mockDb = require('../helpers/setup');
const { generateBullishCandles } = require('../helpers/fixtures');

const { computeFeatures, getLatestFeatures } = require('../../src/ml/featureEngineering');

describe('featureEngineering', () => {
  beforeEach(() => {
    mockDb.reset();
  });

  describe('computeFeatures', () => {
    it('returns 0 for insufficient data', () => {
      // candles query returns too few
      mockDb.pushQueryResult(generateBullishCandles(10));
      // instrument type (queryOne)
      mockDb.pushQueryOneResult({ type: 'STOCK' });

      const result = computeFeatures('PKOBP');
      assert.equal(result, 0);
    });

    it('computes features for sufficient candle data', () => {
      const candles = generateBullishCandles(100);
      // candles query
      mockDb.pushQueryResult(candles);
      // instrument type (queryOne)
      mockDb.pushQueryOneResult({ type: 'STOCK' });
      // For each bar from 50..99, queryOne checks if existing (50 bars)
      for (let i = 50; i < 100; i++) {
        mockDb.pushQueryOneResult(null); // no existing feature
      }

      const count = computeFeatures('PKOBP');
      assert.ok(count > 0, `Should compute at least some features, got ${count}`);
    });

    it('handles FUTURES with lower candle requirement', () => {
      const candles = generateBullishCandles(40);
      mockDb.pushQueryResult(candles);
      mockDb.pushQueryOneResult({ type: 'FUTURES' });
      // For each bar from 26..39, queryOne checks if existing (14 bars)
      for (let i = 26; i < 40; i++) {
        mockDb.pushQueryOneResult(null);
      }

      const count = computeFeatures('FW20');
      assert.ok(count > 0, `FUTURES should compute features with 40 bars, got ${count}`);
    });

    it('skips already-computed features unless force=true', () => {
      const candles = generateBullishCandles(60);
      mockDb.pushQueryResult(candles);
      mockDb.pushQueryOneResult({ type: 'STOCK' });
      // All bars from 50..59 already have features
      for (let i = 50; i < 60; i++) {
        mockDb.pushQueryOneResult({ 1: 1 }); // existing feature
      }

      const count = computeFeatures('PKOBP');
      assert.equal(count, 0, 'Should skip all already-computed bars');
    });
  });

  describe('getLatestFeatures', () => {
    it('returns null when no features exist', () => {
      mockDb.pushQueryOneResult(null);
      const result = getLatestFeatures('UNKNOWN');
      assert.equal(result, null);
    });

    it('returns feature object when available', () => {
      const feat = {
        ticker: 'PKOBP', date: '2025-06-01',
        sma20: 50, sma50: 48, sma200: 45,
        rsi14: 55, rsi7: 58, macd: 0.5,
        atr14: 2.0, regime: 'bullish',
      };
      mockDb.pushQueryOneResult(feat);

      const result = getLatestFeatures('PKOBP');
      assert.ok(result);
      assert.equal(result.ticker, 'PKOBP');
      assert.equal(result.rsi14, 55);
      assert.equal(result.regime, 'bullish');
    });
  });
});
