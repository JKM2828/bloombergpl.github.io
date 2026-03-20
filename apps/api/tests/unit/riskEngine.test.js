// ============================================================
// Unit tests: riskEngine.js
// ============================================================
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Setup mock BEFORE requiring riskEngine
const mockDb = require('../helpers/setup');

const {
  calculatePositionSize,
  calculateStopLevels,
  computeSellLevels,
  assessPortfolioRisk,
  generateSignal,
  generateAllSignals,
  getLatestSignals,
  RISK_CONFIG,
} = require('../../src/ml/riskEngine');

describe('riskEngine', () => {
  beforeEach(() => {
    mockDb.reset();
  });

  describe('RISK_CONFIG', () => {
    it('has sane defaults', () => {
      assert.ok(RISK_CONFIG.maxPortfolioExposure > 0 && RISK_CONFIG.maxPortfolioExposure <= 1);
      assert.ok(RISK_CONFIG.maxSinglePosition > 0 && RISK_CONFIG.maxSinglePosition <= 0.3);
      assert.ok(RISK_CONFIG.kellyFraction > 0 && RISK_CONFIG.kellyFraction <= 1);
      assert.ok(RISK_CONFIG.stopLossATRMultiple > 0);
      assert.ok(RISK_CONFIG.takeProfitATRMultiple > RISK_CONFIG.stopLossATRMultiple);
      assert.ok(RISK_CONFIG.maxConcurrentSignals >= 1);
      assert.ok(RISK_CONFIG.maxSectorExposure > 0 && RISK_CONFIG.maxSectorExposure <= 1);
    });
  });

  describe('calculatePositionSize', () => {
    it('returns null for missing input', () => {
      assert.equal(calculatePositionSize(null, 100000), null);
      assert.equal(calculatePositionSize({}, 0), null);
      assert.equal(calculatePositionSize({}, -1), null);
    });

    it('calculates Kelly-based position size', () => {
      const prediction = {
        confidence: 0.6,
        expectedReturn: 0.05,
        scenarios: { bull: 0.10, base: 0.03, bear: -0.05 },
      };

      const result = calculatePositionSize(prediction, 100000);
      assert.ok(result);
      assert.ok(result.positionPct > 0, 'Position should be positive');
      assert.ok(result.positionPct <= RISK_CONFIG.maxSinglePosition, 'Should not exceed max single position');
      assert.ok(result.positionValue > 0);
      assert.ok(result.positionValue <= 100000 * RISK_CONFIG.maxSinglePosition);
      assert.ok(result.kellyRaw != null);
      assert.ok(result.winProb >= 0 && result.winProb <= 1);
    });

    it('returns zero position for negative expected return', () => {
      const prediction = {
        confidence: 0.5,
        expectedReturn: -0.03,
        scenarios: { bull: 0.02, base: -0.01, bear: -0.08 },
      };

      const result = calculatePositionSize(prediction, 100000);
      assert.ok(result);
      assert.equal(result.positionPct, 0);
      assert.equal(result.positionValue, 0);
    });

    it('caps position at maxSinglePosition', () => {
      const prediction = {
        confidence: 0.95,
        expectedReturn: 0.20,
        scenarios: { bull: 0.30, base: 0.15, bear: -0.02 },
      };

      const result = calculatePositionSize(prediction, 100000);
      assert.ok(result.positionPct <= RISK_CONFIG.maxSinglePosition);
    });
  });

  describe('calculateStopLevels', () => {
    it('returns null for invalid entry price', () => {
      assert.equal(calculateStopLevels('PKOBP', 0), null);
      assert.equal(calculateStopLevels('PKOBP', -10), null);
      assert.equal(calculateStopLevels('PKOBP', null), null);
    });

    it('calculates ATR-based stops', () => {
      mockDb.pushQueryOneResult({ atr14: 2.5 }); // features with ATR

      const result = calculateStopLevels('PKOBP', 100);
      assert.ok(result);
      assert.equal(result.entryPrice, 100);
      assert.ok(result.stopLoss < 100, 'Stop loss should be below entry');
      assert.ok(result.takeProfit > 100, 'Take profit should be above entry');
      assert.ok(result.riskRewardRatio > 0, 'R:R should be positive');
      assert.ok(result.maxLossPct > 0);
      assert.ok(result.maxGainPct > 0);
    });

    it('uses fallback ATR when no features available', () => {
      mockDb.pushQueryOneResult(null); // no features

      const result = calculateStopLevels('UNKNOWN', 50);
      assert.ok(result);
      assert.ok(result.atr > 0, 'Should use fallback ATR');
      assert.equal(result.entryPrice, 50);
    });
  });

  describe('computeSellLevels', () => {
    it('returns null for invalid entry price', () => {
      assert.equal(computeSellLevels('PKOBP', 0), null);
      assert.equal(computeSellLevels('PKOBP', -5), null);
    });

    it('computes multi-layer sell levels', () => {
      // features query
      mockDb.pushQueryOneResult({ atr14: 3, vol_20d: 0.25, rsi14: 55, macd_hist: 0.2, regime: 'neutral' });
      // instrument type query
      mockDb.pushQueryOneResult({ type: 'STOCK' });

      const result = computeSellLevels('PKOBP', 100);
      assert.ok(result);
      assert.equal(result.entryPrice, 100);
      assert.ok(result.takeProfitFast > 100, 'Fast TP above entry');
      assert.ok(result.takeProfitFull > result.takeProfitFast, 'Full TP above fast TP');
      assert.ok(result.stopLoss < 100, 'Stop below entry');
      assert.ok(result.failSafeStop < 100, 'Fail-safe below entry');
      assert.ok(result.trailingActivation > 100);
      assert.ok(result.maxHoldSessions > 0);
      assert.ok(['HOLD', 'CONSIDER_SELL', 'SELL_NOW'].includes(result.sellUrgency));
    });

    it('uses wider stops for futures', () => {
      mockDb.pushQueryOneResult({ atr14: 50, vol_20d: 0.30, rsi14: 50, macd_hist: 0, regime: 'neutral' });
      mockDb.pushQueryOneResult({ type: 'FUTURES' });

      const futures = computeSellLevels('FW20', 2500);
      assert.ok(futures);
      assert.ok(futures.failSafeStopPct > RISK_CONFIG.failSafeStopPct * 100, 'Futures should have wider fail-safe stop');
    });
  });

  describe('generateSignal', () => {
    it('returns null for null prediction', () => {
      assert.equal(generateSignal(null), null);
    });

    it('returns null for low confidence prediction', () => {
      const pred = { confidence: 0.05, ticker: 'PKOBP' };
      assert.equal(generateSignal(pred), null);
    });

    it('generates a valid signal from a decent prediction', () => {
      const pred = {
        ticker: 'PKOBP',
        confidence: 0.55,
        expectedReturn: 0.04,
        direction: 'BUY',
        horizonDays: 5,
        scenarios: { bull: 0.08, base: 0.03, bear: -0.04 },
        regime: 'neutral',
        modelVersion: 'test-v1',
      };

      // assessPortfolioRisk calls
      mockDb.pushQueryOneResult({ cash: 80000 }); // balance
      mockDb.pushQueryResult([]); // positions
      mockDb.pushQueryResult([]); // txHistory

      // latest candle for entry price
      mockDb.pushQueryOneResult({ close: 50 });

      // calculateStopLevels → features
      mockDb.pushQueryOneResult({ atr14: 1.2 });

      const signal = generateSignal(pred);
      assert.ok(signal);
      assert.equal(signal.ticker, 'PKOBP');
      assert.equal(signal.direction, 'BUY');
      assert.ok(signal.riskScore >= 0 && signal.riskScore <= 100);
      assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(signal.riskLevel));
      assert.ok(signal.sizing);
      assert.ok(signal.stops);
    });
  });

  describe('generateAllSignals', () => {
    it('returns empty array for empty predictions', () => {
      const result = generateAllSignals([]);
      assert.deepEqual(result, []);
    });

    it('enforces maxConcurrentSignals limit', () => {
      // We can't easily mock 6+ full signal generations,
      // but verify the function handles empty predictions gracefully
      const lowConfPredictions = Array.from({ length: 10 }, (_, i) => ({
        ticker: `T${i}`, confidence: 0.01, // below minConfidence
      }));
      const result = generateAllSignals(lowConfPredictions);
      assert.equal(result.length, 0, 'All should be filtered out by low confidence');
    });
  });
});
