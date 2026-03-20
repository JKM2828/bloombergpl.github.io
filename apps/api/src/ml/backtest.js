// ============================================================
// Walk-Forward Backtest Engine
//
// Evaluates prediction quality on historical data using
// rolling train/test windows. Computes profit factor,
// expectancy, hit rate, and quality gates.
// ============================================================
const { NeuralNetwork } = require('./neuralNet');
const { query, queryOne, run, saveDb } = require('../db/connection');

/**
 * Walk-forward backtest for a single ticker.
 * Splits data into rolling windows: train on N bars, test on M bars, step forward.
 *
 * @param {string} ticker
 * @param {object} opts - { trainBars, testBars, horizonDays, step }
 * @returns {{ ticker, trades, hitRate, profitFactor, expectancy, avgReturn, maxDD, passed }}
 */
function walkForwardBacktest(ticker, opts = {}) {
  const trainBars = opts.trainBars || 200;
  const testBars = opts.testBars || 40;
  const horizonDays = opts.horizonDays || 5;
  const step = opts.step || 20;

  // Load all features + forward returns
  const rows = query(`
    SELECT f.date, f.rsi14, f.rsi7, f.macd, f.macd_hist,
           f.sma20, f.sma50, f.sma200, f.bb_upper, f.bb_lower,
           f.vol_20d, f.momentum_1m, f.momentum_3m, f.volume_ratio,
           f.max_dd_60d, f.regime,
           f.pivot_r2, f.pivot_r1, f.pivot_pp, f.pivot_s1, f.pivot_s2,
           f.vwap_proxy, f.momentum_5d, f.momentum_10d, f.relative_strength,
           c.close as current_close,
           (SELECT c2.close FROM candles c2 WHERE c2.ticker = f.ticker
            AND c2.date > f.date ORDER BY c2.date ASC LIMIT 1 OFFSET ?) as future_close
    FROM features f
    JOIN candles c ON c.ticker = f.ticker AND c.date = f.date AND (c.timeframe = '1d' OR c.timeframe IS NULL)
    WHERE f.ticker = ?
    ORDER BY f.date ASC
  `, [horizonDays - 1, ticker]);

  if (rows.length < trainBars + testBars) {
    return { ticker, error: 'insufficient data', trades: 0, passed: false };
  }

  // Build normalized samples
  const samples = [];
  for (const f of rows) {
    if (!f.future_close || !f.current_close || f.rsi14 == null) continue;
    const fwdReturn = (f.future_close - f.current_close) / f.current_close;
    const input = normalizeBacktest(f);
    if (!input) continue;
    samples.push({ date: f.date, input: Object.values(input), fwdReturn });
  }

  if (samples.length < trainBars + testBars) {
    return { ticker, error: 'insufficient valid samples', trades: 0, passed: false };
  }

  // Walk-forward loop
  const allTrades = [];
  for (let start = 0; start + trainBars + testBars <= samples.length; start += step) {
    const trainSlice = samples.slice(start, start + trainBars);
    const testSlice = samples.slice(start + trainBars, start + trainBars + testBars);

    // Train a small NN
    const trainingData = trainSlice.map(s => ({
      input: s.input,
      output: [
        s.fwdReturn > 0.005 ? 1 : 0,
        s.fwdReturn < -0.005 ? 1 : 0,
        Math.min(Math.max((s.fwdReturn + 0.2) / 0.4, 0), 1),
      ],
    }));

    const inputSize = trainingData[0].input.length;
    const net = new NeuralNetwork({
      layers: [inputSize, Math.max(Math.ceil(inputSize * 1.3), 16), Math.max(Math.ceil(inputSize * 0.65), 8), 3],
      activation: 'leaky-relu',
      learningRate: 0.01,
    });
    net.train(trainingData, { iterations: 300, errorThresh: 0.01 });

    // Test
    for (const s of testSlice) {
      const pred = net.run(s.input);
      const direction = pred[0] > pred[1] ? 'BUY' : 'SELL';
      const confidence = Math.abs(pred[0] - pred[1]);
      // Only trade if confidence above min gate
      if (confidence < 0.15) continue;
      allTrades.push({
        date: s.date,
        direction,
        confidence,
        actualReturn: s.fwdReturn,
        pnl: direction === 'BUY' ? s.fwdReturn : -s.fwdReturn,
      });
    }
  }

  if (allTrades.length === 0) {
    return { ticker, trades: 0, hitRate: 0, profitFactor: 0, expectancy: 0, passed: false };
  }

  // Compute metrics
  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const hitRate = wins.length / allTrades.length;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) || 0.001;
  const profitFactor = grossProfit / grossLoss;
  const expectancy = allTrades.reduce((s, t) => s + t.pnl, 0) / allTrades.length;
  const avgReturn = allTrades.reduce((s, t) => s + t.actualReturn, 0) / allTrades.length;

  // Max drawdown on equity curve
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of allTrades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  // Quality gates
  const passed = hitRate >= 0.45 && profitFactor >= 1.1 && expectancy > 0 && allTrades.length >= 10;

  return {
    ticker,
    trades: allTrades.length,
    hitRate: Math.round(hitRate * 10000) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    expectancy: Math.round(expectancy * 10000) / 10000,
    avgReturn: Math.round(avgReturn * 10000) / 10000,
    maxDD: Math.round(maxDD * 10000) / 10000,
    passed,
  };
}

/**
 * Run backtest for all active instruments.
 */
function backtestAll(opts = {}) {
  const instruments = query("SELECT ticker FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','INDEX','FUTURES')");
  const results = [];
  for (const inst of instruments) {
    const result = walkForwardBacktest(inst.ticker, opts);
    results.push(result);
  }
  const passed = results.filter(r => r.passed);
  console.log(`[backtest] Complete: ${results.length} tickers, ${passed.length} passed quality gates`);

  // Persist summary
  run(`INSERT INTO backtest_results (run_date, total_tickers, passed_tickers, avg_hit_rate, avg_profit_factor, avg_expectancy, details)
       VALUES (datetime('now'), ?, ?, ?, ?, ?, ?)`,
    [
      results.length,
      passed.length,
      results.length > 0 ? Math.round(results.reduce((s, r) => s + (r.hitRate || 0), 0) / results.length * 100) / 100 : 0,
      results.length > 0 ? Math.round(results.reduce((s, r) => s + (r.profitFactor || 0), 0) / results.length * 100) / 100 : 0,
      results.length > 0 ? Math.round(results.reduce((s, r) => s + (r.expectancy || 0), 0) / results.length * 10000) / 10000 : 0,
      JSON.stringify(results),
    ]
  );
  saveDb();

  return { total: results.length, passed: passed.length, results };
}

// Normalize features for backtest (mirrors mlEngine.normalizeInputs)
function normalizeBacktest(f) {
  if (f.rsi14 == null) return null;
  return {
    rsi14: (f.rsi14 || 50) / 100,
    rsi7: (f.rsi7 || 50) / 100,
    macd_norm: Math.tanh((f.macd || 0) / 10),
    macd_hist_norm: Math.tanh((f.macd_hist || 0) / 5),
    bb_pos: f.bb_upper && f.bb_lower && f.sma20
      ? (f.sma20 - f.bb_lower) / (f.bb_upper - f.bb_lower || 1) : 0.5,
    vol_norm: Math.min((f.vol_20d || 0.25) / 0.6, 1),
    mom1m: Math.tanh((f.momentum_1m || 0) * 5),
    mom3m: Math.tanh((f.momentum_3m || 0) * 3),
    volume_ratio: Math.min((f.volume_ratio || 1) / 3, 1),
    dd_norm: Math.min((f.max_dd_60d || 0) / 0.3, 1),
    sma_cross: f.sma50 && f.sma200 ? (f.sma50 > f.sma200 ? 1 : 0) : 0.5,
    regime_bull: f.regime === 'bullish' ? 1 : 0,
    regime_bear: f.regime === 'bearish' ? 1 : 0,
    pivot_pos: f.pivot_pp ? Math.tanh(((f.sma20 || 0) - f.pivot_pp) / (Math.abs(f.pivot_r1 - f.pivot_s1) || 1)) : 0,
    vwap_dist: f.vwap_proxy ? Math.tanh(((f.sma20 || 0) - f.vwap_proxy) / (f.vwap_proxy || 1) * 10) : 0,
    mom5d: Math.tanh((f.momentum_5d || 0) * 8),
    mom10d: Math.tanh((f.momentum_10d || 0) * 5),
    rel_strength: Math.tanh((f.relative_strength || 0) * 5),
  };
}

module.exports = { walkForwardBacktest, backtestAll };
