// ============================================================
// Portfolio simulation module
// Virtual cash account: deposit, withdraw, buy, sell, PnL
// ============================================================
const { query, queryOne, run, saveDb } = require('../db/connection');

const DEFAULT_USER = 'default';

function getBalance(userId = DEFAULT_USER) {
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
  const balance = getBalance(userId);
  if (cost > balance) throw new Error(`Niewystarczające środki. Koszt: ${cost} PLN, dostępne: ${balance} PLN`);
  run('INSERT INTO portfolio_transactions (user_id, type, ticker, shares, price, amount) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, 'buy', ticker, shares, price, cost]);
  saveDb();
  return { ticker, shares, price, cost, balance: getBalance(userId) };
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
  run('INSERT INTO portfolio_transactions (user_id, type, ticker, shares, price, amount) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, 'sell', ticker, shares, price, proceeds]);
  saveDb();
  return { ticker, shares, price, proceeds, balance: getBalance(userId) };
}

function getTransactionHistory(userId = DEFAULT_USER, limit = 50) {
  return query('SELECT * FROM portfolio_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}

module.exports = { getBalance, getPositions, deposit, withdraw, buy, sell, getTransactionHistory };
