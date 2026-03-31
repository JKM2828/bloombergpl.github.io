// ============================================================
// Top Gainers T+1 — Dedicated ranking model
//
// Predicts which tickers will have the highest % return
// on the next trading session (T+1). Outputs a ranked list
// of Top 5 expected gainers with probability and predicted %.
//
// Separate from the main 5-day ML engine — different horizon,
// different objective (relative rank, not BUY/SELL direction).
//
// Pipeline: train → predict → rank → persist → validate
// ============================================================
const { NeuralNetwork } = require('./neuralNet');
const { query, queryOne, run, saveDb } = require('../db/connection');
const { getLatestFeatures } = require('./featureEngineering');

const MODEL_PREFIX = 't1-rank-v';
let t1TrainedNet = null;
let t1ModelVersion = null;

// ============================================================
// FEATURE NORMALIZATION (T+1 specific)
// ============================================================

function normalizeT1(f) {
  if (f.rsi14 == null) return null;

  return {
    // Momentum features (short-term emphasis)
    mom5d: Math.tanh((f.momentum_5d || 0) * 10),
    mom10d: Math.tanh((f.momentum_10d || 0) * 6),
    mom1m: Math.tanh((f.momentum_1m || 0) * 5),

    // RSI momentum zone
    rsi14: (f.rsi14 || 50) / 100,
    rsi7: (f.rsi7 || 50) / 100,
    rsi_diff: Math.tanh(((f.rsi7 || 50) - (f.rsi14 || 50)) / 20),

    // MACD momentum
    macd_hist_norm: Math.tanh((f.macd_hist || 0) / 5),

    // Volatility & range
    vol_norm: Math.min((f.vol_20d || 0.25) / 0.6, 1),
    atr_pct: f.atr14 && f.sma20 ? Math.tanh(f.atr14 / (f.sma20 || 1) * 20) : 0,

    // Volume dynamics
    volume_ratio: Math.min((f.volume_ratio || 1) / 3, 1),
    vol_accel: Math.tanh((f.vol_accel || 1) - 1),

    // Impulse / candle features
    gap_pct: Math.tanh((f.gap_pct || 0) * 20),
    range_expansion: Math.tanh(((f.range_expansion || 1) - 1) * 2),
    close_position: f.close_position != null ? f.close_position : 0.5,
    upper_shadow: f.upper_shadow_pct != null ? f.upper_shadow_pct : 0.5,
    body_pct: f.body_pct != null ? f.body_pct : 0.5,

    // Cross-sectional ranks
    mom_rank: f.mom1d_rank != null ? f.mom1d_rank : 0.5,
    vol_rank: f.vol_rank != null ? f.vol_rank : 0.5,
    rs_rank: f.rs_rank != null ? f.rs_rank : 0.5,

    // Trend context
    sma_cross: f.sma50 && f.sma200 ? (f.sma50 > f.sma200 ? 1 : 0) : 0.5,
    bb_pos: f.bb_upper && f.bb_lower && f.sma20
      ? (f.sma20 - f.bb_lower) / (f.bb_upper - f.bb_lower || 1) : 0.5,

    // Relative strength
    rel_strength: Math.tanh((f.relative_strength || 0) * 5),
    sector_rs: Math.tanh((f.sector_rs || 0) * 5),

    // Regime one-hot
    regime_bull: f.regime === 'bullish' ? 1 : 0,
    regime_bear: f.regime === 'bearish' ? 1 : 0,

    // Drawdown risk
    dd_norm: Math.min((f.max_dd_60d || 0) / 0.3, 1),
  };
}

// ============================================================
// TRAINING — cross-sectional ranking model
// ============================================================

/**
 * Train the T+1 model using ALL tickers together (cross-sectional).
 * Target: 1-day forward return and top-5 membership.
 */
function trainT1Model(opts = {}) {
  const lookback = opts.lookback || 300;

  // Get all feature rows with 1-day forward returns
  const instruments = query(
    "SELECT ticker FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','FUTURES')"
  );

  // Group by date for cross-sectional labels
  const dateMap = new Map(); // date → [{ticker, features, fwdReturn}]

  for (const inst of instruments) {
    const rows = query(`
      SELECT f.*, c.close as current_close,
        (SELECT c2.close FROM candles c2
         WHERE c2.ticker = f.ticker AND c2.date > f.date
         ORDER BY c2.date ASC LIMIT 1) as future_close
      FROM features f
      JOIN candles c ON c.ticker = f.ticker AND c.date = f.date
        AND (c.timeframe = '1d' OR c.timeframe IS NULL)
      WHERE f.ticker = ?
      ORDER BY f.date DESC
      LIMIT ?
    `, [inst.ticker, lookback]);

    for (const row of rows) {
      if (!row.future_close || !row.current_close || row.rsi14 == null) continue;
      const fwdReturn = (row.future_close - row.current_close) / row.current_close;

      if (!dateMap.has(row.date)) dateMap.set(row.date, []);
      dateMap.get(row.date).push({
        ticker: inst.ticker,
        features: row,
        fwdReturn,
      });
    }
  }

  // Build training data: each sample gets cross-sectional rank info
  const trainingData = [];
  const dates = [...dateMap.keys()].sort();

  for (const date of dates) {
    const dayRows = dateMap.get(date);
    if (dayRows.length < 5) continue; // need enough tickers per day

    // Sort by forward return to assign top-5 labels
    dayRows.sort((a, b) => b.fwdReturn - a.fwdReturn);
    const n = dayRows.length;

    for (let i = 0; i < n; i++) {
      const row = dayRows[i];
      const inputObj = normalizeT1(row.features);
      if (!inputObj) continue;

      const isTop5 = i < 5 ? 1 : 0;
      const rankPct = n > 1 ? i / (n - 1) : 0.5; // 0 = best, 1 = worst

      trainingData.push({
        input: Object.values(inputObj),
        output: [
          isTop5,
          Math.min(Math.max((row.fwdReturn + 0.15) / 0.30, 0), 1), // return normalized to 0-1
        ],
        meta: { ticker: row.ticker, date, fwdReturn: row.fwdReturn, rank: i + 1 },
      });
    }
  }

  if (trainingData.length < 50) {
    console.log(`[t1] Insufficient cross-sectional training data: ${trainingData.length} samples`);
    return null;
  }

  // Chronological split: 80% train, 20% validation
  const splitIdx = Math.floor(trainingData.length * 0.8);
  const trainSet = trainingData.slice(0, splitIdx);
  const valSet = trainingData.slice(splitIdx);

  // Train neural network
  const inputSize = trainSet[0].input.length;
  const h1 = Math.max(Math.ceil(inputSize * 1.5), 24);
  const h2 = Math.max(Math.ceil(h1 / 2), 12);
  const net = new NeuralNetwork({
    layers: [inputSize, h1, h2, 2], // [top5_prob, return_mag]
    activation: 'leaky-relu',
    learningRate: 0.008,
    l2Lambda: 0.0005,
  });

  const trainResult = net.train(trainSet, {
    iterations: 600,
    errorThresh: 0.008,
  });

  // Validate: group val set by date, measure precision@5
  const valDates = new Map();
  for (const sample of valSet) {
    const d = sample.meta.date;
    if (!valDates.has(d)) valDates.set(d, []);
    const pred = net.run(sample.input);
    valDates.get(d).push({
      ...sample.meta,
      predScore: pred[0] * 0.6 + pred[1] * 0.4, // composite
      actualReturn: sample.meta.fwdReturn,
    });
  }

  let totalHits = 0, totalDays = 0;
  let avgRetTop5 = 0;
  for (const [, dayPreds] of valDates) {
    if (dayPreds.length < 5) continue;
    totalDays++;

    // Sort by predicted score
    dayPreds.sort((a, b) => b.predScore - a.predScore);
    const predTop5 = new Set(dayPreds.slice(0, 5).map(d => d.ticker));

    // Sort by actual return
    dayPreds.sort((a, b) => b.actualReturn - a.actualReturn);
    const actualTop5 = new Set(dayPreds.slice(0, 5).map(d => d.ticker));

    // Count overlap
    for (const t of predTop5) {
      if (actualTop5.has(t)) totalHits++;
    }

    // Avg return of predicted top5
    const predTop5Returns = dayPreds
      .filter(d => predTop5.has(d.ticker))
      .map(d => d.actualReturn);
    avgRetTop5 += predTop5Returns.reduce((s, v) => s + v, 0) / predTop5Returns.length;
  }

  const precision5 = totalDays > 0 ? totalHits / (totalDays * 5) : 0;
  avgRetTop5 = totalDays > 0 ? avgRetTop5 / totalDays : 0;

  // Store model
  t1TrainedNet = net;
  t1ModelVersion = MODEL_PREFIX + Date.now();

  run(`INSERT INTO model_registry (model_name, version, accuracy, training_samples, config, weights, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    ['top_gainers_t1', t1ModelVersion, precision5, trainingData.length,
     JSON.stringify({ layers: [inputSize, h1, h2, 2], type: 'top_gainers_t1', dates: dates.length }),
     JSON.stringify(net.toJSON())]
  );
  saveDb();

  console.log(`[t1] Trained: precision@5=${(precision5 * 100).toFixed(1)}%, avgRetTop5=${(avgRetTop5 * 100).toFixed(2)}%, samples=${trainingData.length}, dates=${dates.length}`);

  return {
    precision5: Math.round(precision5 * 1000) / 10,
    avgRetTop5: Math.round(avgRetTop5 * 10000) / 100,
    samples: trainingData.length,
    trainingDates: dates.length,
    validationDays: totalDays,
    error: trainResult.error,
  };
}

// ============================================================
// PREDICTION — rank all tickers for tomorrow
// ============================================================

/**
 * Generate T+1 predictions for all instruments and produce ranked Top N.
 * @param {number} topN - how many to return (default 5)
 * @returns {Array} ranked predictions
 */
function predictTopGainersT1(topN = 5) {
  if (!t1TrainedNet) loadT1Model();
  if (!t1TrainedNet) {
    console.log('[t1] No trained model available — cannot predict');
    return [];
  }

  const instruments = query(
    "SELECT ticker, name, type FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','FUTURES')"
  );

  const predictions = [];
  for (const inst of instruments) {
    const features = getLatestFeatures(inst.ticker);
    if (!features) continue;

    const inputObj = normalizeT1(features);
    if (!inputObj) continue;

    const raw = t1TrainedNet.run(Object.values(inputObj));
    const top5Prob = raw[0];
    const returnMag = raw[1];

    // Reverse normalize return: returnMag ∈ [0,1] → [-0.15, +0.15]
    const predictedReturn = returnMag * 0.30 - 0.15;

    // Composite score: top5 probability weighted with predicted return
    const compositeScore = top5Prob * 0.6 + Math.max(returnMag, 0) * 0.4;

    // Get current price
    const lastCandle = queryOne(
      'SELECT close, date FROM candles WHERE ticker = ? ORDER BY date DESC LIMIT 1',
      [inst.ticker]
    );

    predictions.push({
      ticker: inst.ticker,
      name: inst.name,
      type: inst.type,
      top5Probability: Math.round(top5Prob * 1000) / 10,
      predictedReturn1D: Math.round(predictedReturn * 10000) / 100,
      compositeScore: Math.round(compositeScore * 1000) / 10,
      currentPrice: lastCandle?.close || null,
      lastDate: lastCandle?.date || null,
      targetPrice: lastCandle ? Math.round(lastCandle.close * (1 + predictedReturn) * 100) / 100 : null,
      rsi14: features.rsi14 != null ? Math.round(features.rsi14 * 100) / 100 : null,
      momentum5d: features.momentum_5d != null ? Math.round(features.momentum_5d * 10000) / 100 : null,
      volumeRatio: features.volume_ratio != null ? Math.round(features.volume_ratio * 100) / 100 : null,
      regime: features.regime,
    });
  }

  // Sort by composite score descending
  predictions.sort((a, b) => b.compositeScore - a.compositeScore);

  // Assign ranks
  predictions.forEach((p, i) => { p.rank = i + 1; });

  // Persist top predictions
  const today = new Date().toISOString().slice(0, 10);
  for (const p of predictions.slice(0, Math.max(topN, 10))) {
    run(`INSERT OR REPLACE INTO top_gainers_t1
      (prediction_date, ticker, rank, predicted_return_1d, top5_probability,
       composite_score, model_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [today, p.ticker, p.rank, p.predictedReturn1D, p.top5Probability,
       p.compositeScore, t1ModelVersion]
    );
  }
  saveDb();

  const top = predictions.slice(0, topN);
  console.log(`[t1] Top ${topN} predicted gainers: ${top.map(p => `${p.ticker}(${p.predictedReturn1D}%)`).join(', ')}`);
  return top;
}

// ============================================================
// VALIDATION — check yesterday's predictions against actuals
// ============================================================

/**
 * Validate past T+1 predictions: compute actual 1D returns and rank accuracy.
 */
function validateT1Predictions() {
  const unvalidated = query(`
    SELECT * FROM top_gainers_t1
    WHERE validated = 0 AND prediction_date <= date('now', '-1 day')
    ORDER BY prediction_date ASC
  `);

  if (unvalidated.length === 0) return { validated: 0 };

  // Group by date
  const byDate = new Map();
  for (const row of unvalidated) {
    if (!byDate.has(row.prediction_date)) byDate.set(row.prediction_date, []);
    byDate.get(row.prediction_date).push(row);
  }

  let totalValidated = 0;

  for (const [predDate, rows] of byDate) {
    // Get actual 1D returns for all predicted tickers
    const actualReturns = [];
    for (const row of rows) {
      const nextCandle = queryOne(
        'SELECT close FROM candles WHERE ticker = ? AND date > ? ORDER BY date ASC LIMIT 1',
        [row.ticker, predDate]
      );
      const predDayCandle = queryOne(
        'SELECT close FROM candles WHERE ticker = ? AND date = ?',
        [row.ticker, predDate]
      );

      if (nextCandle && predDayCandle && predDayCandle.close > 0) {
        const actualReturn = ((nextCandle.close - predDayCandle.close) / predDayCandle.close) * 100;
        actualReturns.push({ ticker: row.ticker, actualReturn, id: row.id, predRank: row.rank });
      }
    }

    if (actualReturns.length === 0) continue;

    // Sort by actual return to get actual ranks
    actualReturns.sort((a, b) => b.actualReturn - a.actualReturn);
    for (let i = 0; i < actualReturns.length; i++) {
      const ar = actualReturns[i];
      run(`UPDATE top_gainers_t1 SET actual_return_1d = ?, actual_rank = ?, validated = 1 WHERE id = ?`,
        [Math.round(ar.actualReturn * 100) / 100, i + 1, ar.id]);
      totalValidated++;
    }

    // Compute KPI for this date
    const predTop5 = rows.filter(r => r.rank <= 5).map(r => r.ticker);
    const actualTop5 = new Set(actualReturns.slice(0, 5).map(r => r.ticker));
    const hits = predTop5.filter(t => actualTop5.has(t)).length;
    const precision5 = predTop5.length > 0 ? hits / predTop5.length : 0;
    const hitAt1 = actualReturns.length > 0 && rows[0] ? (actualReturns[0].ticker === rows.find(r => r.rank === 1)?.ticker ? 1 : 0) : 0;
    const avgReturnTop5 = actualReturns
      .filter(r => predTop5.includes(r.ticker))
      .reduce((s, r) => s + r.actualReturn, 0) / (predTop5.length || 1);
    const avgActualRankTop5 = actualReturns
      .filter(r => predTop5.includes(r.ticker))
      .reduce((s, r, _, arr) => s + (actualReturns.indexOf(r) + 1), 0) / (predTop5.length || 1);

    run(`INSERT INTO top_gainers_kpi
      (eval_date, precision_at_5, hit_at_1, avg_return_top5, avg_actual_rank_top5,
       total_universe, model_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [predDate, Math.round(precision5 * 100), hitAt1,
       Math.round(avgReturnTop5 * 100) / 100,
       Math.round(avgActualRankTop5 * 10) / 10,
       actualReturns.length, rows[0]?.model_version]);
  }

  saveDb();
  console.log(`[t1] Validated ${totalValidated} past T+1 predictions`);
  return { validated: totalValidated };
}

// ============================================================
// WALK-FORWARD BACKTEST
// ============================================================

/**
 * Walk-forward backtest for the T+1 ranking model.
 * Trains on rolling window, tests day-by-day, measures precision@5.
 */
function backtestT1(opts = {}) {
  const trainDays = opts.trainDays || 120;
  const step = opts.step || 5;

  const instruments = query(
    "SELECT ticker FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','FUTURES')"
  );

  // Build cross-sectional dataset grouped by date
  const dateMap = new Map();
  for (const inst of instruments) {
    const rows = query(`
      SELECT f.*, c.close as current_close,
        (SELECT c2.close FROM candles c2
         WHERE c2.ticker = f.ticker AND c2.date > f.date
         ORDER BY c2.date ASC LIMIT 1) as future_close
      FROM features f
      JOIN candles c ON c.ticker = f.ticker AND c.date = f.date
        AND (c.timeframe = '1d' OR c.timeframe IS NULL)
      WHERE f.ticker = ?
      ORDER BY f.date ASC
    `, [inst.ticker]);

    for (const row of rows) {
      if (!row.future_close || !row.current_close || row.rsi14 == null) continue;
      const fwdReturn = (row.future_close - row.current_close) / row.current_close;
      const inputObj = normalizeT1(row);
      if (!inputObj) continue;

      if (!dateMap.has(row.date)) dateMap.set(row.date, []);
      dateMap.get(row.date).push({
        ticker: inst.ticker,
        input: Object.values(inputObj),
        fwdReturn,
      });
    }
  }

  const dates = [...dateMap.keys()].sort();
  // Filter dates with enough tickers
  const validDates = dates.filter(d => (dateMap.get(d)?.length || 0) >= 5);

  if (validDates.length < trainDays + 10) {
    return { error: 'Insufficient data for T+1 backtest', days: validDates.length, needed: trainDays + 10 };
  }

  // Walk-forward: train on trainDays dates, test on next day, step forward
  const results = [];
  for (let i = trainDays; i < validDates.length; i += step) {
    // Collect training data from previous trainDays
    const trainData = [];
    for (let j = Math.max(0, i - trainDays); j < i; j++) {
      const dayRows = dateMap.get(validDates[j]);
      if (!dayRows || dayRows.length < 5) continue;

      dayRows.sort((a, b) => b.fwdReturn - a.fwdReturn);
      const n = dayRows.length;
      for (let k = 0; k < n; k++) {
        trainData.push({
          input: dayRows[k].input,
          output: [
            k < 5 ? 1 : 0,
            Math.min(Math.max((dayRows[k].fwdReturn + 0.15) / 0.30, 0), 1),
          ],
        });
      }
    }

    if (trainData.length < 30) continue;

    // Train small NN
    const inputSize = trainData[0].input.length;
    const net = new NeuralNetwork({
      layers: [inputSize, Math.max(Math.ceil(inputSize * 1.3), 20), Math.max(Math.ceil(inputSize * 0.6), 10), 2],
      activation: 'leaky-relu',
      learningRate: 0.008,
    });
    net.train(trainData, { iterations: 400, errorThresh: 0.01 });

    // Test on next day
    const testDate = validDates[i];
    const testRows = dateMap.get(testDate);
    if (!testRows || testRows.length < 5) continue;

    // Predict and rank
    const preds = testRows.map(row => {
      const raw = net.run(row.input);
      return {
        ticker: row.ticker,
        predScore: raw[0] * 0.6 + raw[1] * 0.4,
        actualReturn: row.fwdReturn,
      };
    });

    preds.sort((a, b) => b.predScore - a.predScore);
    const predTop5 = new Set(preds.slice(0, 5).map(p => p.ticker));

    preds.sort((a, b) => b.actualReturn - a.actualReturn);
    const actualTop5 = new Set(preds.slice(0, 5).map(p => p.ticker));

    const hits = [...predTop5].filter(t => actualTop5.has(t)).length;
    const hitAt1 = preds[0]?.ticker === [...predTop5][0] ? 1 : 0;

    // Avg return of predicted top 5
    const predTop5Returns = preds
      .filter(p => predTop5.has(p.ticker))
      .map(p => p.actualReturn);
    const avgRetTop5 = predTop5Returns.reduce((s, v) => s + v, 0) / predTop5Returns.length;

    results.push({
      date: testDate,
      precision5: hits / 5,
      hitAt1,
      avgRetTop5,
      universe: testRows.length,
    });
  }

  if (results.length === 0) {
    return { error: 'No valid test days', days: 0 };
  }

  const avgPrecision = results.reduce((s, r) => s + r.precision5, 0) / results.length;
  const avgHit1 = results.reduce((s, r) => s + r.hitAt1, 0) / results.length;
  const avgRet = results.reduce((s, r) => s + r.avgRetTop5, 0) / results.length;

  // Persist
  run(`INSERT INTO backtest_results (run_date, total_tickers, passed_tickers, avg_hit_rate, avg_profit_factor, avg_expectancy, details)
       VALUES (datetime('now'), ?, ?, ?, ?, ?, ?)`,
    [results.length, results.filter(r => r.precision5 >= 0.2).length,
     Math.round(avgPrecision * 100 * 100) / 100,
     Math.round(avgHit1 * 100 * 100) / 100,
     Math.round(avgRet * 10000) / 10000,
     JSON.stringify({ type: 'top_gainers_t1', results: results.slice(-20) })]
  );
  saveDb();

  console.log(`[t1-backtest] ${results.length} test days | precision@5=${(avgPrecision * 100).toFixed(1)}% | hit@1=${(avgHit1 * 100).toFixed(1)}% | avgRetTop5=${(avgRet * 100).toFixed(2)}%`);

  return {
    testDays: results.length,
    precision5: Math.round(avgPrecision * 1000) / 10,
    hitAt1: Math.round(avgHit1 * 1000) / 10,
    avgRetTop5: Math.round(avgRet * 10000) / 100,
    bestDays: results.sort((a, b) => b.avgRetTop5 - a.avgRetTop5).slice(0, 5),
    worstDays: results.sort((a, b) => a.avgRetTop5 - b.avgRetTop5).slice(0, 5),
  };
}

// ============================================================
// KPI & MONITORING
// ============================================================

/**
 * Get latest T+1 KPI stats.
 */
function getT1KPI(days = 30) {
  const stats = queryOne(`
    SELECT
      COUNT(*) as total_days,
      AVG(precision_at_5) as avg_precision5,
      AVG(hit_at_1) as avg_hit1,
      AVG(avg_return_top5) as avg_ret_top5,
      AVG(avg_actual_rank_top5) as avg_actual_rank
    FROM top_gainers_kpi
    WHERE eval_date >= date('now', '-' || ? || ' days')
  `, [days]);

  if (!stats || stats.total_days === 0) return null;

  return {
    totalDays: stats.total_days,
    precision5: Math.round((stats.avg_precision5 || 0) * 100) / 100,
    hitAt1: Math.round((stats.avg_hit1 || 0) * 100) / 100,
    avgReturnTop5: Math.round((stats.avg_ret_top5 || 0) * 100) / 100,
    avgActualRank: Math.round((stats.avg_actual_rank || 0) * 10) / 10,
  };
}

/**
 * Get latest predicted top gainers from DB.
 */
function getLatestTopGainersT1(limit = 5) {
  const lastDate = queryOne('SELECT MAX(prediction_date) as d FROM top_gainers_t1')?.d;
  if (!lastDate) return { predictions: [], predictionDate: null };

  const predictions = query(`
    SELECT tg.*, i.name, i.type,
      (SELECT c.close FROM candles c WHERE c.ticker = tg.ticker ORDER BY c.date DESC LIMIT 1) as currentPrice,
      (SELECT c.date FROM candles c WHERE c.ticker = tg.ticker ORDER BY c.date DESC LIMIT 1) as lastDate
    FROM top_gainers_t1 tg
    JOIN instruments i ON i.ticker = tg.ticker
    WHERE tg.prediction_date = ?
    ORDER BY tg.rank ASC
    LIMIT ?
  `, [lastDate, limit]);

  return {
    predictions,
    predictionDate: lastDate,
    modelVersion: predictions[0]?.model_version || null,
  };
}

// ============================================================
// MODEL LOADING
// ============================================================

function loadT1Model() {
  const model = queryOne(
    "SELECT weights, version FROM model_registry WHERE model_name = 'top_gainers_t1' AND status = 'active' ORDER BY created_at DESC LIMIT 1"
  );
  if (!model?.weights) return false;
  try {
    const json = JSON.parse(model.weights);
    t1TrainedNet = NeuralNetwork.fromJSON(json);
    t1ModelVersion = model.version;
    console.log(`[t1] Loaded T+1 model: ${model.version}`);
    return true;
  } catch (e) {
    console.warn(`[t1] Failed to load T+1 model: ${e.message}`);
    return false;
  }
}

module.exports = {
  trainT1Model,
  predictTopGainersT1,
  validateT1Predictions,
  backtestT1,
  getT1KPI,
  getLatestTopGainersT1,
  loadT1Model,
};
