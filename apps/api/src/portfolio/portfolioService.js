// ============================================================
// Portfolio simulation module
// Virtual cash account: deposit, withdraw, buy, sell, PnL
// Supports T+2 settlement delay: sell proceeds are pending
// for 2 business days before becoming available for new buys.
// ============================================================
const { query, queryOne, run, saveDb } = require('../db/connection');

const DEFAULT_USER = 'default';
const SETTLEMENT_DAYS = 2; // T+2

/**
 * Add N business days to a date (skip weekends).
 */
function addBusinessDays(dateStr, days) {
  const d = new Date(dateStr);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Total balance (settled + pending) — the full accounting view.
 */
function getTotalBalance(userId = DEFAULT_USER) {
  const row = queryOne(`
    SELECT COALESCE(SUM(
      CASE
        WHEN type = 'deposit' THEN amount
        WHEN type = 'withdraw' THEN -amount
        WHEN type = 'buy' THEN -amount
        WHEN type = 'sell' THEN amount
        ELSE 0
      END
    ), 0) AS balance
    FROM portfolio_transactions
    WHERE user_id = ?
  `, [userId]);
  return row ? row.balance : 0;
}

/**
 * Cash available for new purchases (excludes pending settlement).
 */
function getAvailableBalance(userId = DEFAULT_USER) {
  const today = new Date().toISOString().slice(0, 10);
  const row = queryOne(`
    SELECT COALESCE(SUM(
      CASE
        WHEN type = 'deposit' THEN amount
        WHEN type = 'withdraw' THEN -amount
        WHEN type = 'buy' THEN -amount
        WHEN type = 'sell' AND (settlement_status = 'settled' OR settlement_date <= ?) THEN amount
        ELSE 0
      END
    ), 0) AS balance
    FROM portfolio_transactions
    WHERE user_id = ?
  `, [today, userId]);
  return row ? row.balance : 0;
}

/**
 * Cash pending settlement — not yet available for new buys.
 */
function getPendingCash(userId = DEFAULT_USER) {
  const today = new Date().toISOString().slice(0, 10);
  const row = queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS pending
    FROM portfolio_transactions
    WHERE user_id = ? AND type = 'sell'
      AND settlement_status = 'pending'
      AND (settlement_date IS NULL OR settlement_date > ?)
  `, [userId, today]);
  return row ? row.pending : 0;
}

/**
 * Settle matured transactions (settlement_date <= today).
 * Called by worker periodically and on balance queries.
 * @returns {number} count of settled transactions
 */
function settleMaturedTransactions(userId = DEFAULT_USER) {
  const today = new Date().toISOString().slice(0, 10);
  const result = run(
    `UPDATE portfolio_transactions SET settlement_status = 'settled'
     WHERE user_id = ? AND settlement_status = 'pending' AND settlement_date <= ?`,
    [userId, today]
  );
  const settled = result?.changes || 0;
  if (settled > 0) saveDb();
  return settled;
}

// Backward-compatible alias
function getBalance(userId = DEFAULT_USER) {
  settleMaturedTransactions(userId);
  return getAvailableBalance(userId);
}

function getPositions(userId = DEFAULT_USER) {
  const rows = query(`
    SELECT ticker,
      SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END) -
      SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END) AS shares,
      SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END) AS totalCost,
      SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END) AS totalBought
    FROM portfolio_transactions
    WHERE user_id = ? AND ticker IS NOT NULL
    GROUP BY ticker
    HAVING shares > 0
  `, [userId]);

  return rows.map((r) => {
    const avgPrice = r.totalBought > 0 ? r.totalCost / r.totalBought : 0;
    const lastCandle = queryOne(
      'SELECT close FROM candles WHERE ticker = ? ORDER BY date DESC LIMIT 1',
      [r.ticker]
    );
    const currentPrice = lastCandle ? lastCandle.close : avgPrice;
    const value = r.shares * currentPrice;
    const pnl = (currentPrice - avgPrice) * r.shares;
    const pnlPct = avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0;
    return {
      ticker: r.ticker, shares: r.shares,
      avgPrice: Math.round(avgPrice * 100) / 100, currentPrice,
      value: Math.round(value * 100) / 100,
      pnl: Math.round(pnl * 100) / 100,
      pnlPct: Math.round(pnlPct * 100) / 100,
    };
  });
}

function deposit(amount, userId = DEFAULT_USER) {
  if (amount <= 0) throw new Error('Kwota wpłaty musi być > 0');
  run('INSERT INTO portfolio_transactions (user_id, type, amount) VALUES (?, ?, ?)', [userId, 'deposit', amount]);
  saveDb();
  return { balance: getBalance(userId) };
}

function withdraw(amount, userId = DEFAULT_USER) {
  if (amount <= 0) throw new Error('Kwota wypłaty musi być > 0');
  const balance = getBalance(userId);
  if (amount > balance) throw new Error(`Niewystarczające środki. Dostępne: ${balance} PLN`);
  run('INSERT INTO portfolio_transactions (user_id, type, amount) VALUES (?, ?, ?)', [userId, 'withdraw', amount]);
  saveDb();
  return { balance: getBalance(userId) };
}

function buy(ticker, shares, userId = DEFAULT_USER) {
  if (shares <= 0) throw new Error('Liczba akcji musi być > 0');
  const lastCandle = queryOne('SELECT close FROM candles WHERE ticker = ? ORDER BY date DESC LIMIT 1', [ticker]);
  if (!lastCandle) throw new Error(`Brak danych cenowych dla ${ticker}`);
  const price = lastCandle.close;
  const cost = shares * price;
  settleMaturedTransactions(userId);
  const available = getAvailableBalance(userId);
  if (cost > available) {
    const pending = getPendingCash(userId);
    if (pending > 0) {
      throw new Error(`Niewystarczające środki. Koszt: ${cost} PLN, dostępne: ${available} PLN (${pending} PLN w rozliczeniu T+2)`);
    }
    throw new Error(`Niewystarczające środki. Koszt: ${cost} PLN, dostępne: ${available} PLN`);
  }
  run('INSERT INTO portfolio_transactions (user_id, type, ticker, shares, price, amount, settlement_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, 'buy', ticker, shares, price, cost, 'settled']);
  saveDb();
  return { ticker, shares, price, cost, balance: getAvailableBalance(userId), pendingCash: getPendingCash(userId) };
}

function sell(ticker, shares, userId = DEFAULT_USER) {
  if (shares <= 0) throw new Error('Liczba akcji musi być > 0');
  const positions = getPositions(userId);
  const pos = positions.find((p) => p.ticker === ticker);
  if (!pos || pos.shares < shares) {
    throw new Error(`Nie posiadasz wystarczającej liczby akcji ${ticker}. Posiadane: ${pos?.shares || 0}`);
  }
  const lastCandle = queryOne('SELECT close FROM candles WHERE ticker = ? ORDER BY date DESC LIMIT 1', [ticker]);
  const price = lastCandle ? lastCandle.close : pos.currentPrice;
  const proceeds = shares * price;
  const today = new Date().toISOString().slice(0, 10);
  const settlementDate = addBusinessDays(today, SETTLEMENT_DAYS);
  run('INSERT INTO portfolio_transactions (user_id, type, ticker, shares, price, amount, settlement_status, settlement_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, 'sell', ticker, shares, price, proceeds, 'pending', settlementDate]);
  saveDb();
  return {
    ticker, shares, price, proceeds,
    balance: getAvailableBalance(userId),
    pendingCash: getPendingCash(userId),
    settlementDate,
  };
}

function getTransactionHistory(userId = DEFAULT_USER, limit = 50) {
  return query('SELECT * FROM portfolio_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}

module.exports = {
  getBalance, getTotalBalance, getAvailableBalance, getPendingCash,
  settleMaturedTransactions, addBusinessDays,
  getPositions, deposit, withdraw, buy, sell, getTransactionHistory,
  SETTLEMENT_DAYS,
};
