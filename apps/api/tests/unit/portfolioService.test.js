// ============================================================
// Unit tests: portfolioService.js  (TEST-H1)
// ============================================================
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Setup mock DB BEFORE requiring portfolioService
const mockDb = require('../helpers/setup');

const {
  getBalance,
  getAvailableBalance,
  getTotalBalance,
  getPendingCash,
  settleMaturedTransactions,
  addBusinessDays,
  SETTLEMENT_DAYS,
  getPositions,
  deposit,
  withdraw,
  buy,
  sell,
  getTransactionHistory,
} = require('../../src/portfolio/portfolioService');

describe('portfolioService', () => {
  beforeEach(() => {
    mockDb.reset();
  });

  // ---- getBalance ----
  describe('getBalance', () => {
    it('returns 0 when no transactions', () => {
      mockDb.setQueryOneResult({ balance: 0 });
      assert.equal(getBalance(), 0);
    });

    it('returns balance from queryOne result', () => {
      mockDb.setQueryOneResult({ balance: 5000 });
      assert.equal(getBalance(), 5000);
    });

    it('returns 0 when queryOne returns null', () => {
      mockDb.setQueryOneResult(null);
      assert.equal(getBalance(), 0);
    });
  });

  // ---- deposit ----
  describe('deposit', () => {
    it('throws for zero amount', () => {
      assert.throws(() => deposit(0), /musi być > 0/);
    });

    it('throws for negative amount', () => {
      assert.throws(() => deposit(-100), /musi być > 0/);
    });

    it('returns updated balance after deposit', () => {
      // After run(), getBalance() is called — set up mock return
      mockDb.setQueryOneResult({ balance: 1000 });
      const result = deposit(1000);
      assert.ok(result.balance != null);
      assert.equal(result.balance, 1000);
    });
  });

  // ---- withdraw ----
  describe('withdraw', () => {
    it('throws for zero amount', () => {
      mockDb.setQueryOneResult({ balance: 5000 });
      assert.throws(() => withdraw(0), /musi być > 0/);
    });

    it('throws when insufficient funds', () => {
      // First call: getBalance → 500; second call getBalance after transaction → not reached
      mockDb.pushQueryOneResult({ balance: 500 });
      assert.throws(() => withdraw(1000), /Niewystarczające środki/);
    });

    it('succeeds when sufficient funds', () => {
      // getBalance check, then getBalance after run()
      mockDb.pushQueryOneResult({ balance: 5000 });
      mockDb.pushQueryOneResult({ balance: 4000 });
      const result = withdraw(1000);
      assert.equal(result.balance, 4000);
    });
  });

  // ---- buy ----
  describe('buy', () => {
    it('throws for zero shares', () => {
      assert.throws(() => buy('PKOBP', 0), /musi być > 0/);
    });

    it('throws for negative shares', () => {
      assert.throws(() => buy('PKOBP', -5), /musi być > 0/);
    });

    it('throws when no price data', () => {
      mockDb.setQueryOneResult(null); // no candle
      assert.throws(() => buy('PKOBP', 10), /Brak danych cenowych/);
    });

    it('throws when insufficient funds', () => {
      mockDb.pushQueryOneResult({ close: 100 });    // candle price
      mockDb.pushQueryOneResult({ balance: 500 });  // balance (< 10 * 100 = 1000)
      assert.throws(() => buy('PKOBP', 10), /Niewystarczające środki/);
    });

    it('returns buy result with correct fields', () => {
      mockDb.pushQueryOneResult({ close: 50 });     // candle
      mockDb.pushQueryOneResult({ balance: 10000 }); // getBalance check
      mockDb.pushQueryOneResult({ balance: 9500 });  // getBalance after run()
      const result = buy('PKOBP', 10);
      assert.equal(result.ticker, 'PKOBP');
      assert.equal(result.shares, 10);
      assert.equal(result.price, 50);
      assert.equal(result.cost, 500);
      assert.equal(result.balance, 9500);
    });

    it('calculates cost correctly', () => {
      mockDb.pushQueryOneResult({ close: 125.50 });   // candle
      mockDb.pushQueryOneResult({ balance: 50000 });  // balance check
      mockDb.pushQueryOneResult({ balance: 49373.5 }); // balance after
      const result = buy('CDR', 5);
      assert.equal(result.cost, 5 * 125.50);
    });
  });

  // ---- sell ----
  describe('sell', () => {
    it('throws for zero shares', () => {
      mockDb.pushQueryResult([]); // getPositions query
      assert.throws(() => sell('PKOBP', 0), /musi być > 0/);
    });

    it('throws when no position', () => {
      mockDb.pushQueryResult([]); // no positions
      assert.throws(() => sell('PKOBP', 10), /Nie posiadasz/);
    });

    it('throws when insufficient shares', () => {
      // getPositions returns position with 5 shares
      mockDb.pushQueryResult([{ ticker: 'PKOBP', shares: 5, totalCost: 500, totalBought: 5 }]);
      mockDb.pushQueryOneResult(null); // no candle for getPositions currentPrice
      assert.throws(() => sell('PKOBP', 10), /Nie posiadasz/);
    });

    it('returns sell result with settlement fields', () => {
      // getPositions: shares calc
      mockDb.pushQueryResult([{ ticker: 'PKOBP', shares: 20, totalCost: 2000, totalBought: 20 }]);
      // getPositions currentPrice candle
      mockDb.pushQueryOneResult({ close: 110 });
      // sell: queryOne for candle
      mockDb.pushQueryOneResult({ close: 110 });
      // getAvailableBalance after run()
      mockDb.pushQueryOneResult({ balance: 11100 });
      // getPendingCash after run()
      mockDb.pushQueryOneResult({ pending: 1100 });
      const result = sell('PKOBP', 10);
      assert.equal(result.ticker, 'PKOBP');
      assert.equal(result.shares, 10);
      assert.equal(result.price, 110);
      assert.equal(result.proceeds, 1100);
      assert.ok(result.settlementDate, 'settlement date should be present');
      assert.ok(result.pendingCash != null, 'pending cash should be returned');
    });
  });

  // ---- getTransactionHistory ----
  describe('getTransactionHistory', () => {
    it('returns empty array when no transactions', () => {
      mockDb.setQueryResults([]);
      const result = getTransactionHistory();
      assert.deepEqual(result, []);
    });

    it('returns transactions', () => {
      const txList = [
        { id: 1, type: 'deposit', amount: 5000, user_id: 'default' },
        { id: 2, type: 'buy', ticker: 'PKOBP', shares: 10, price: 45, amount: 450, user_id: 'default' },
      ];
      mockDb.setQueryResults(txList);
      const result = getTransactionHistory();
      assert.equal(result.length, 2);
      assert.equal(result[0].type, 'deposit');
    });
  });

  // ---- PnL calculation (via getPositions) ----
  describe('getPositions PnL', () => {
    it('computes PnL correctly', () => {
      // positions query
      mockDb.pushQueryResult([{
        ticker: 'CDR',
        shares: 10,
        totalCost: 1000,  // 10 shares at 100 avg
        totalBought: 10,
      }]);
      // current price candle
      mockDb.pushQueryOneResult({ close: 120 });
      const positions = getPositions();
      assert.equal(positions.length, 1);
      const pos = positions[0];
      assert.equal(pos.ticker, 'CDR');
      assert.equal(pos.shares, 10);
      assert.equal(pos.avgPrice, 100);
      assert.equal(pos.currentPrice, 120);
      assert.equal(pos.value, 1200);
      assert.equal(pos.pnl, 200);   // (120 - 100) * 10
      assert.ok(Math.abs(pos.pnlPct - 20) < 0.01); // 20%
    });

    it('uses avgPrice as currentPrice when no candle', () => {
      mockDb.pushQueryResult([{
        ticker: 'PKOBP',
        shares: 5,
        totalCost: 250,  // avg 50
        totalBought: 5,
      }]);
      mockDb.pushQueryOneResult(null); // no candle
      const positions = getPositions();
      const pos = positions[0];
      assert.equal(pos.currentPrice, 50); // falls back to avgPrice
      assert.equal(pos.pnl, 0);
      assert.equal(pos.pnlPct, 0);
    });

    it('returns empty array when no positions', () => {
      mockDb.pushQueryResult([]);
      const positions = getPositions();
      assert.deepEqual(positions, []);
    });
  });

  // ---- T+2 Settlement ----
  describe('T+2 settlement', () => {
    it('SETTLEMENT_DAYS is 2', () => {
      assert.equal(SETTLEMENT_DAYS, 2);
    });

    it('addBusinessDays skips weekends', () => {
      // Friday 2026-04-10 + 2 business days = Tuesday 2026-04-14
      assert.equal(addBusinessDays('2026-04-10', 2), '2026-04-14');
      // Monday 2026-04-13 + 2 business days = Wednesday 2026-04-15
      assert.equal(addBusinessDays('2026-04-13', 2), '2026-04-15');
      // Wednesday + 2 = Friday
      assert.equal(addBusinessDays('2026-04-15', 2), '2026-04-17');
    });

    it('addBusinessDays handles 0 days', () => {
      assert.equal(addBusinessDays('2026-04-10', 0), '2026-04-10');
    });

    it('buy reports pending cash in error message', () => {
      // candle price
      mockDb.pushQueryOneResult({ close: 100 });
      // settleMaturedTransactions (run returns nothing special in mock)
      // getAvailableBalance
      mockDb.pushQueryOneResult({ balance: 500 });
      // getPendingCash
      mockDb.pushQueryOneResult({ pending: 1000 });
      assert.throws(() => buy('CDR', 10), /w rozliczeniu T\+2/);
    });

    it('buy works when available balance is sufficient', () => {
      // candle
      mockDb.pushQueryOneResult({ close: 50 });
      // settleMaturedTransactions (no-op)
      // getAvailableBalance
      mockDb.pushQueryOneResult({ balance: 5000 });
      // after buy: getAvailableBalance
      mockDb.pushQueryOneResult({ balance: 4500 });
      // getPendingCash
      mockDb.pushQueryOneResult({ pending: 0 });
      const result = buy('PKO', 10);
      assert.equal(result.cost, 500);
      assert.equal(result.balance, 4500);
      assert.equal(result.pendingCash, 0);
    });

    it('sell returns settlement date 2+ business days in the future', () => {
      mockDb.pushQueryResult([{ ticker: 'CDR', shares: 10, totalCost: 1000, totalBought: 10 }]);
      mockDb.pushQueryOneResult({ close: 120 }); // getPositions candle
      mockDb.pushQueryOneResult({ close: 120 }); // sell candle
      mockDb.pushQueryOneResult({ balance: 1200 }); // getAvailableBalance
      mockDb.pushQueryOneResult({ pending: 1200 }); // getPendingCash
      const result = sell('CDR', 10);
      assert.ok(result.settlementDate);
      // Settlement should be at least 2 days after today
      const today = new Date().toISOString().slice(0, 10);
      assert.ok(result.settlementDate > today, `settlement ${result.settlementDate} should be after ${today}`);
    });
  });
});
