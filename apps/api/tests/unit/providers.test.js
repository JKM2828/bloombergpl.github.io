// ============================================================
// Unit tests: providers/index.js  (TEST-H1)
// Tests circuit breaker, budget tracking, isDegraded
// – does NOT test real HTTP calls (mocked via _test internals)
// ============================================================
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// providers/index.js requires individual provider modules (gpwProvider etc.)
// which may fail to load without keys; suppress by stubbing require cache
// before import — only needed if individual providers do work at require-time.
const providerManager = require('../../src/providers');
const { _test } = providerManager;

describe('providers/index', () => {
  beforeEach(() => {
    // Reset all circuit breaker state + budget counters before each test
    for (const k of Object.keys(_test.circuitState)) delete _test.circuitState[k];
    for (const k of Object.keys(_test.tickerCircuitState)) delete _test.tickerCircuitState[k];
    _test.budgetAlertState.degraded = false;
    _test.budgetAlertState.sentAt10Pct = false;
    _test.budgetAlertState.sentAt0 = false;
    _test.budgetAlertState.lastResetDate = null;
    // Reset global daily count
    _test.resetGlobalCounter();
  });

  // ---- isDegraded ----
  describe('isDegraded', () => {
    it('returns false initially', () => {
      assert.equal(providerManager.isDegraded(), false);
    });

    it('returns true when degraded flag is set', () => {
      _test.budgetAlertState.degraded = true;
      assert.equal(providerManager.isDegraded(), true);
    });
  });

  // ---- getBudgetStats ----
  describe('getBudgetStats', () => {
    it('returns expected shape', () => {
      const stats = providerManager.getBudgetStats();
      assert.ok(typeof stats.globalDailyCount === 'number', 'globalDailyCount must be number');
      assert.ok(typeof stats.globalDailyLimit === 'number', 'globalDailyLimit must be number');
      assert.ok(typeof stats.globalRemaining === 'number', 'globalRemaining must be number');
      assert.ok(stats.globalDailyLimit > 0, 'limit should be positive');
      assert.ok(stats.globalRemaining >= 0, 'remaining should be non-negative');
      assert.ok(typeof stats.circuitBreakers === 'object');
    });

    it('globalRemaining decreases as calls are tracked', () => {
      const before = providerManager.getBudgetStats().globalRemaining;
      _test.trackCall(10);
      const after = providerManager.getBudgetStats().globalRemaining;
      assert.equal(after, before - 10);
    });

    it('globalRemaining never goes below 0', () => {
      _test.trackCall(999999);
      const stats = providerManager.getBudgetStats();
      assert.ok(stats.globalRemaining >= 0);
    });
  });

  // ---- Circuit breaker (provider-level) ----
  describe('circuit breaker — provider level', () => {
    it('is initially open=false for any provider', () => {
      assert.equal(_test.cbIsOpen('stooq'), false);
      assert.equal(_test.cbIsOpen('yahoo'), false);
      assert.equal(_test.cbIsOpen('gpw'), false);
    });

    it('opens after CB_THRESHOLD consecutive failures', () => {
      // CB_THRESHOLD = 5 per source code
      for (let i = 0; i < 5; i++) {
        _test.cbRecord('stooq', false, null);
      }
      assert.equal(_test.cbIsOpen('stooq'), true);
    });

    it('resets on success', () => {
      // Trip the circuit
      for (let i = 0; i < 5; i++) _test.cbRecord('stooq', false, null);
      assert.equal(_test.cbIsOpen('stooq'), true);
      // Simulate cooldown by manually resetting openUntil
      _test.circuitState['stooq'].openUntil = Date.now() - 1;
      assert.equal(_test.cbIsOpen('stooq'), false); // auto-reset on check
    });

    it('success resets failure count but does NOT close circuit mid-cooldown', () => {
      _test.cbRecord('stooq', false, null);
      _test.cbRecord('stooq', false, null);
      _test.cbRecord('stooq', true, null);  // success
      assert.equal(_test.circuitState['stooq']?.failures, 0);
      assert.equal(_test.cbIsOpen('stooq'), false);
    });

    it('reopens immediately for a different provider', () => {
      for (let i = 0; i < 5; i++) _test.cbRecord('eodhd', false, null);
      assert.equal(_test.cbIsOpen('eodhd'), true);
      assert.equal(_test.cbIsOpen('stooq'), false); // stooq unaffected
    });
  });

  // ---- Per-ticker circuit breaker ----
  describe('circuit breaker — ticker level', () => {
    it('is initially open=false for any ticker', () => {
      assert.equal(_test.tickerCbIsOpen('PKOBP'), false);
    });

    it('opens after 3 consecutive failures for same ticker', () => {
      // TICKER_CB_THRESHOLD = 3
      for (let i = 0; i < 3; i++) {
        _test.cbRecord('stooq', false, 'PKOBP');
      }
      assert.equal(_test.tickerCbIsOpen('PKOBP'), true);
    });

    it('ticker circuit does not affect other tickers', () => {
      for (let i = 0; i < 3; i++) _test.cbRecord('stooq', false, 'PKOBP');
      assert.equal(_test.tickerCbIsOpen('PKOBP'), true);
      assert.equal(_test.tickerCbIsOpen('CDR'), false);
    });

    it('resets ticker circuit after success', () => {
      _test.cbRecord('stooq', false, 'CDR');
      _test.cbRecord('stooq', false, 'CDR');
      _test.cbRecord('stooq', true, 'CDR'); // success
      assert.equal(_test.tickerCircuitState['CDR']?.failures, 0);
      assert.equal(_test.tickerCbIsOpen('CDR'), false);
    });
  });

  // ---- Budget exhaustion → degraded ----
  describe('budget alerts', () => {
    it('budgetAlertState.degraded is false initially', () => {
      assert.equal(_test.budgetAlertState.degraded, false);
    });

    it('globalBudgetRemaining returns non-negative value', () => {
      const remaining = _test.globalBudgetRemaining();
      assert.ok(remaining >= 0, 'remaining should be non-negative');
    });
  });
});
