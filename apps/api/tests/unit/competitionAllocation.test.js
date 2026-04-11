// ============================================================
// Unit tests: Competition Allocation (computeCompetitionAllocation)
// ============================================================
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const mockDb = require('../helpers/setup');

const {
  computeCompetitionAllocation,
  COMPETITION_DEFAULTS,
} = require('../../src/ml/riskEngine');

describe('computeCompetitionAllocation', () => {
  beforeEach(() => {
    mockDb.reset();
  });

  it('returns blocked when pick is null', () => {
    const result = computeCompetitionAllocation(null);
    assert.equal(result.blocked, true);
    assert.ok(result.blockReasons.includes('no_pick'));
    assert.equal(result.shares, 0);
  });

  it('returns blocked when no price data', () => {
    const pick = { ticker: 'CDR', ml: { confidence: 60, expectedReturn: 5 }, compositeScore: 50 };
    const result = computeCompetitionAllocation(pick);
    assert.equal(result.blocked, true);
    assert.ok(result.blockReasons.includes('no_price_data'));
  });

  it('blocks when confidence is too low', () => {
    const pick = {
      ticker: 'CDR', type: 'STOCK',
      metrics: { lastClose: 200 },
      ml: { confidence: 10, expectedReturn: 5 }, // 10% = 0.10 < 0.40
      compositeScore: 50,
      sell: { failSafeStopPct: 6 },
    };
    const result = computeCompetitionAllocation(pick);
    assert.equal(result.blocked, true);
    assert.ok(result.blockReasons.some(r => r.startsWith('confidence_low')));
  });

  it('blocks when expected return is too low', () => {
    const pick = {
      ticker: 'CDR', type: 'STOCK',
      metrics: { lastClose: 200 },
      ml: { confidence: 60, expectedReturn: 0.1 }, // 0.1% = 0.001 < 0.008
      compositeScore: 50,
      sell: { failSafeStopPct: 6 },
    };
    const result = computeCompetitionAllocation(pick);
    assert.equal(result.blocked, true);
    assert.ok(result.blockReasons.some(r => r.startsWith('expected_return_low')));
  });

  it('blocks when composite score is too low', () => {
    const pick = {
      ticker: 'CDR', type: 'STOCK',
      metrics: { lastClose: 200 },
      ml: { confidence: 60, expectedReturn: 5 },
      compositeScore: 10, // < 30
      sell: { failSafeStopPct: 6 },
    };
    const result = computeCompetitionAllocation(pick);
    assert.equal(result.blocked, true);
    assert.ok(result.blockReasons.some(r => r.startsWith('score_low')));
  });

  it('blocks when direction is SELL', () => {
    const pick = {
      ticker: 'CDR', type: 'STOCK',
      metrics: { lastClose: 200 },
      ml: { confidence: 60, expectedReturn: 5, direction: 'SELL' },
      compositeScore: 50,
      sell: { failSafeStopPct: 6 },
    };
    const result = computeCompetitionAllocation(pick);
    assert.equal(result.blocked, true);
    assert.ok(result.blockReasons.includes('direction_sell'));
  });

  it('allocates shares for valid STOCK pick with default budget', () => {
    const pick = {
      ticker: 'CDR', type: 'STOCK',
      metrics: { lastClose: 200 },
      ml: { confidence: 60, expectedReturn: 5, direction: 'BUY' },
      compositeScore: 55,
      sell: { failSafeStopPct: 6 },
    };
    const result = computeCompetitionAllocation(pick);
    assert.equal(result.blocked, false);
    assert.ok(result.shares > 0);
    assert.ok(result.investedAmount <= 20000);
    assert.ok(result.investedAmount > 0);
    assert.equal(result.budget, 20000);
    assert.equal(result.isFutures, false);
  });

  it('respects custom budget', () => {
    const pick = {
      ticker: 'CDR', type: 'STOCK',
      metrics: { lastClose: 100 },
      ml: { confidence: 70, expectedReturn: 8, direction: 'BUY' },
      compositeScore: 65,
      sell: { failSafeStopPct: 6 },
    };
    const result = computeCompetitionAllocation(pick, { budget: 10000 });
    assert.ok(result.investedAmount <= 10000);
    assert.equal(result.budget, 10000);
  });

  it('caps FUTURES allocation at 60%', () => {
    const pick = {
      ticker: 'FW20', type: 'FUTURES',
      metrics: { lastClose: 50 },
      ml: { confidence: 80, expectedReturn: 10, direction: 'BUY' },
      compositeScore: 70,
      sell: { failSafeStopPct: 8 },
    };
    const result = computeCompetitionAllocation(pick);
    assert.equal(result.isFutures, true);
    assert.ok(result.allocPct <= 0.60, `allocPct ${result.allocPct} should be <= 0.60`);
    assert.ok(result.investedAmount <= 20000 * 0.60 + 1); // +1 for rounding
  });

  it('never exceeds budget', () => {
    const pick = {
      ticker: 'ABC', type: 'STOCK',
      metrics: { lastClose: 0.50 }, // very cheap stock
      ml: { confidence: 90, expectedReturn: 20, direction: 'BUY' },
      compositeScore: 90,
      sell: { failSafeStopPct: 6 },
    };
    const result = computeCompetitionAllocation(pick);
    assert.ok(result.investedAmount <= 20000, `invested ${result.investedAmount} should be <= 20000`);
  });

  it('rounds shares down (no fractional shares)', () => {
    const pick = {
      ticker: 'XYZ', type: 'STOCK',
      metrics: { lastClose: 333.33 },
      ml: { confidence: 60, expectedReturn: 5, direction: 'BUY' },
      compositeScore: 50,
      sell: { failSafeStopPct: 6 },
    };
    const result = computeCompetitionAllocation(pick);
    assert.equal(result.shares, Math.floor(result.shares));
  });

  it('uses entryPrice fallback when lastClose is missing', () => {
    const pick = {
      ticker: 'XYZ', type: 'STOCK',
      entryPrice: 150,
      metrics: {},
      ml: { confidence: 60, expectedReturn: 5, direction: 'BUY' },
      compositeScore: 50,
      sell: { failSafeStopPct: 6 },
    };
    const result = computeCompetitionAllocation(pick);
    assert.equal(result.blocked, false);
    assert.equal(result.price, 150);
  });
});
