// ============================================================
// Unit tests: feedMonitor.js
// ============================================================
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Setup mock BEFORE requiring feedMonitor
const mockDb = require('../helpers/setup');

const { assessFeedQuality, assessAllFeedQuality } = require('../../src/ingest/feedMonitor');

describe('feedMonitor', () => {
  beforeEach(() => {
    mockDb.reset();
  });

  describe('assessFeedQuality', () => {
    it('returns unhealthy when no data exists', () => {
      mockDb.setQueryResults([]);
      const result = assessFeedQuality('PKOBP', '1d');
      assert.equal(result.healthy, false);
      assert.ok(result.issues.includes('No data'));
      assert.equal(result.fallbackRecommended, true);
    });

    it('returns healthy for fresh, clean data', () => {
      const today = new Date().toISOString().split('T')[0];
      const candles = [];
      for (let i = 30; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        // Skip weekends
        if (d.getDay() === 0 || d.getDay() === 6) continue;
        candles.push({
          date: d.toISOString().split('T')[0],
          open: 100, high: 105, low: 95, close: 102, volume: 50000,
        });
      }
      mockDb.setQueryResults(candles);
      const result = assessFeedQuality('PKOBP', '1d');
      assert.equal(result.healthy, true);
      assert.equal(result.issues.length, 0);
    });

    it('detects stale data', () => {
      const old = new Date();
      old.setDate(old.getDate() - 10);
      mockDb.setQueryResults([
        { date: old.toISOString().split('T')[0], open: 10, high: 11, low: 9, close: 10, volume: 1000 },
      ]);
      const result = assessFeedQuality('PKOBP', '1d');
      assert.equal(result.healthy, false);
      assert.ok(result.issues.some(i => i.includes('Stale')));
    });

    it('detects zero prices', () => {
      const today = new Date().toISOString().split('T')[0];
      mockDb.setQueryResults([
        { date: today, open: 0, high: 0, low: 0, close: 0, volume: 1000 },
      ]);
      const result = assessFeedQuality('TEST', '1d');
      assert.ok(result.issues.some(i => i.includes('zero/null')));
    });

    it('detects duplicate dates', () => {
      const today = new Date().toISOString().split('T')[0];
      const candle = { date: today, open: 10, high: 11, low: 9, close: 10, volume: 500 };
      mockDb.setQueryResults([candle, candle]); // same date twice
      const result = assessFeedQuality('TEST', '1d');
      assert.ok(result.issues.some(i => i.includes('duplicate')));
    });

    it('recommends fallback for unhealthy intraday data', () => {
      const old = new Date();
      old.setDate(old.getDate() - 5);
      mockDb.setQueryResults([
        { date: old.toISOString().split('T')[0], open: 10, high: 11, low: 9, close: 10, volume: 1000 },
      ]);
      const result = assessFeedQuality('PKOBP', '1h');
      assert.equal(result.fallbackRecommended, true);
    });
  });

  describe('assessAllFeedQuality', () => {
    it('reports summary for instruments', () => {
      // First call: instruments query (uses query())
      mockDb.pushQueryResult([
        { ticker: 'PKOBP', type: 'STOCK' },
      ]);
      // assessFeedQuality calls query() for daily candles
      const today = new Date().toISOString().split('T')[0];
      const freshCandle = { date: today, open: 100, high: 105, low: 95, close: 102, volume: 50000 };
      mockDb.pushQueryResult([freshCandle]); // daily candles
      mockDb.pushQueryResult([freshCandle]); // intraday candles

      const result = assessAllFeedQuality();
      assert.equal(result.totalInstruments, 1);
      assert.equal(typeof result.healthPct, 'number');
      const stats = mockDb.getStats();
      assert.equal(stats.queryCalls, 3, 'assessAllFeedQuality should use one instruments query + two batched candle queries');
    });
  });
});
