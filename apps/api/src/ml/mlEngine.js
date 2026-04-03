// ============================================================
// ML Engine – Neural network ensemble for GPW predictions
//
// Uses custom pure-JS neural network (no native deps) +
// technical rules ensemble. Predicts: direction, expected
// return, confidence, and 3 scenarios (bull/base/bear).
//
// Model lifecycle: train → validate → register → serve
// ============================================================
const { NeuralNetwork } = require('./neuralNet');
const { query, queryOne, run, saveDb } = require('../db/connection');
const { getLatestFeatures } = require('./featureEngineering');

const MODEL_VERSION_PREFIX = 'nn-v';
let currentModelVersion = null;
let trainedNets = {}; // ticker → NeuralNetwork

// ============================================================
// TRAINING
// ============================================================

/**
 * Train model for a single ticker using historical features + labels.
 * Labels: forward 5-day return and direction.
 */
function trainForTicker(ticker, opts = {}) {
  const lookback = opts.lookback || 500;
  const horizonDays = opts.horizonDays || 5;

  // Get features joined with forward returns
  const features = query(`
    SELECT f.*, 
      (SELECT c2.close FROM candles c2 
       WHERE c2.ticker = f.ticker AND c2.date > f.date
       ORDER BY c2.date ASC LIMIT 1 OFFSET ?) as future_close,
      (SELECT c1.close FROM candles c1
       WHERE c1.ticker = f.ticker AND c1.date = f.date) as current_close
    FROM features f
    WHERE f.ticker = ? 
    ORDER BY f.date DESC
    LIMIT ?
  `, [horizonDays - 1, ticker, lookback]);

  // Build training set
  const trainingData = [];
  for (const f of features) {
    if (!f.future_close || !f.current_close || !f.rsi14) continue;
    const fwdReturn = (f.future_close - f.current_close) / f.current_close;

    const inputObj = normalizeInputs(f);
    if (!inputObj) continue;

    // Convert object values to array for our custom NN
    const input = Object.values(inputObj);
    const output = [
      fwdReturn > 0.005 ? 1 : 0,        // up
      fwdReturn < -0.005 ? 1 : 0,        // down
      Math.min(Math.max((fwdReturn + 0.2) / 0.4, 0), 1), // returnMag
    ];

    trainingData.push({ input, output });
  }

  if (trainingData.length < 20) {
    // Adaptive threshold: FUTURES/INDEX can train with fewer samples
    const inst = queryOne('SELECT type FROM instruments WHERE ticker = ?', [ticker]);
    const isFuturesLike = inst?.type === 'FUTURES' || inst?.type === 'INDEX';
    const minSamples = isFuturesLike ? 8 : 20;
    if (trainingData.length < minSamples) {
      console.log(`[ml] ${ticker}(${inst?.type}): insufficient data (${trainingData.length}/${minSamples} samples)`);
      return null;
    }
    console.log(`[ml] ${ticker}(${inst?.type}): adaptive mode – ${trainingData.length} samples`);
  }

  // Split train/validate (80/20) — TEMPORAL split to prevent data leakage
  // Data is ordered DESC from query, reverse for chronological order
  const chronological = trainingData.reverse();
  const splitIdx = Math.floor(chronological.length * 0.8);
  const trainSet = chronological.slice(0, splitIdx);
  const valSet = chronological.slice(splitIdx);

  // Train custom neural network (18 inputs → 24 → 12 → 3 outputs)
  const inputSize = trainSet[0].input.length;
  const hiddenSize1 = Math.max(Math.ceil(inputSize * 1.3), 16);
  const hiddenSize2 = Math.max(Math.ceil(hiddenSize1 / 2), 8);
  const net = new NeuralNetwork({
    layers: [inputSize, hiddenSize1, hiddenSize2, 3],
    activation: 'leaky-relu',
    learningRate: 0.01,
  });

  const trainResult = net.train(trainSet, {
    iterations: 500,
    errorThresh: 0.01,
  });

  // Validate
  let correct = 0;
  for (const sample of valSet) {
    const pred = net.run(sample.input);
    const predDir = pred[0] > pred[1] ? 'up' : 'down';           // [up, down, returnMag]
    const actualDir = sample.output[0] > 0.5 ? 'up' : 'down';
    if (predDir === actualDir) correct++;
  }
  const accuracy = valSet.length > 0 ? correct / valSet.length : 0;

  // Store trained network
  trainedNets[ticker] = net;
  const version = MODEL_VERSION_PREFIX + Date.now();

  // Register in DB (store network weights as JSON)
  run(`INSERT INTO model_registry (model_name, version, accuracy, training_samples, config, weights, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    [ticker, version, accuracy, trainingData.length,
     JSON.stringify({ layers: [inputSize, hiddenSize1, hiddenSize2, 3], horizonDays, lookback }),
     JSON.stringify(net.toJSON())]
  );

  saveDb();
  console.log(`[ml] ${ticker}: trained, accuracy=${(accuracy * 100).toFixed(1)}%, samples=${trainingData.length}`);

  return { ticker, version, accuracy, samples: trainingData.length, error: trainResult.error };
}

/**
 * Train models for all instruments with enough data.
 */
function trainAll(opts = {}) {
  const instruments = query("SELECT ticker FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','INDEX','FUTURES')");
  const results = [];
  for (const inst of instruments) {
    const result = trainForTicker(inst.ticker, opts);
    if (result) results.push(result);
  }
  currentModelVersion = MODEL_VERSION_PREFIX + Date.now();
  console.log(`[ml] Training complete: ${results.length} models trained`);
  return results;
}

// ============================================================
// PREDICTION / INFERENCE
// ============================================================

/**
 * Generate prediction for a single ticker using trained model + rules ensemble.
 */
function predict(ticker, horizonDays = 5) {
  const features = getLatestFeatures(ticker);
  if (!features) return null;

  const inputObj = normalizeInputs(features);
  if (!inputObj) return null;

  const inputArr = Object.values(inputObj);

  // Neural network prediction (array: [up, down, returnMag])
  let nnPred = null;
  if (trainedNets[ticker]) {
    // Validate input: ensure no NaN/Infinity reaches NN
    const hasInvalid = inputArr.some(v => !Number.isFinite(v));
    if (!hasInvalid) {
      const raw = trainedNets[ticker].run(inputArr);
      // Guard: validate NN output
      if (raw.every(v => Number.isFinite(v))) {
        nnPred = { up: raw[0], down: raw[1], returnMag: raw[2] };
      } else {
        console.warn(`[ml] ${ticker}: NN returned NaN/Infinity, falling back to rules`);
      }
    } else {
      console.warn(`[ml] ${ticker}: input contains NaN/Infinity, falling back to rules`);
    }
  }

  // Rule-based signals (ensemble member 2)
  const rulePred = ruleBasedPrediction(features);

  // Ensemble: weighted average (NN 60%, Rules 40%)
  const nnWeight = nnPred ? 0.6 : 0;
  const ruleWeight = nnPred ? 0.4 : 1.0;

  const upProb = (nnPred ? nnPred.up * nnWeight : 0) + rulePred.upProb * ruleWeight;
  const downProb = (nnPred ? nnPred.down * nnWeight : 0) + rulePred.downProb * ruleWeight;

  const direction = upProb > downProb ? 'BUY' : upProb < downProb ? 'SELL' : 'HOLD';
  // Calibrated confidence: cap at 0.95 and apply sigmoid squash to avoid overconfidence
  const rawConf = Math.abs(upProb - downProb);
  const confidence = Math.min(rawConf / (rawConf + 0.15), 0.95);

  // Expected return from NN magnitude
  let expectedReturn = 0;
  if (nnPred) {
    expectedReturn = (nnPred.returnMag * 0.4 - 0.2); // reverse normalization
  } else {
    expectedReturn = rulePred.expectedReturn;
  }

  // Scenarios (bull/base/bear) using historical return distribution
  const vol = features.vol_20d || 0.25;
  // Query recent daily returns to compute empirical percentiles
  const recentReturns = query(
    `SELECT (c2.close - c1.close) / c1.close AS ret
     FROM candles c1
     JOIN candles c2 ON c2.ticker = c1.ticker AND c2.date > c1.date
       AND c2.rowid = (SELECT MIN(rowid) FROM candles WHERE ticker = c1.ticker AND date > c1.date AND (timeframe IS NULL OR timeframe = '1d'))
     WHERE c1.ticker = ? AND (c1.timeframe IS NULL OR c1.timeframe = '1d')
     ORDER BY c1.date DESC LIMIT 60`,
    [ticker]
  ).map(r => r.ret).filter(r => Number.isFinite(r)).sort((a, b) => a - b);

  let bullSpread, bearSpread;
  if (recentReturns.length >= 20) {
    // Use 75th percentile for bull, 25th for bear
    const p75 = recentReturns[Math.floor(recentReturns.length * 0.75)];
    const p25 = recentReturns[Math.floor(recentReturns.length * 0.25)];
    bullSpread = Math.max(p75, vol * 0.2);
    bearSpread = Math.min(p25, -vol * 0.2);
  } else {
    // Fallback to volatility-based scaling
    bullSpread = vol * 0.5;
    bearSpread = -vol * 0.5;
  }

  const scenarios = {
    bull: expectedReturn + bullSpread,
    base: expectedReturn,
    bear: expectedReturn + bearSpread,
  };

  const version = currentModelVersion || 'rules-only';

  // Persist prediction
  run(`INSERT INTO predictions 
    (ticker, model_version, prediction_date, horizon_days, 
     predicted_return, confidence, predicted_direction,
     scenario_bull, scenario_base, scenario_bear, features_used)
    VALUES (?,?,datetime('now'),?,?,?,?,?,?,?,?)`,
    [ticker, version, horizonDays,
     r4(expectedReturn), r4(confidence), direction,
     r4(scenarios.bull), r4(scenarios.base), r4(scenarios.bear),
     JSON.stringify(Object.keys(inputObj))]
  );

  saveDb();

  return {
    ticker, direction, confidence: r4(confidence),
    expectedReturn: r4(expectedReturn * 100),
    scenarios: {
      bull: r4(scenarios.bull * 100),
      base: r4(scenarios.base * 100),
      bear: r4(scenarios.bear * 100),
    },
    horizonDays,
    modelVersion: version,
    regime: features.regime,
    rsi: features.rsi14,
    macd_hist: features.macd_hist,
  };
}

/**
 * Generate predictions for all instruments.
 */
function predictAll(horizonDays = 5) {
  const instruments = query("SELECT ticker FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','INDEX','FUTURES')");
  const predictions = [];
  for (const inst of instruments) {
    const pred = predict(inst.ticker, horizonDays);
    if (pred) predictions.push(pred);
  }

  // Sort by confidence * abs(expectedReturn)
  predictions.sort((a, b) => {
    const scoreA = a.confidence * Math.abs(a.expectedReturn);
    const scoreB = b.confidence * Math.abs(b.expectedReturn);
    return scoreB - scoreA;
  });

  console.log(`[ml] Predictions generated: ${predictions.length}`);
  return predictions;
}

/**
 * Get latest prediction from DB.
 */
function getLatestPrediction(ticker) {
  return queryOne(
    'SELECT * FROM predictions WHERE ticker = ? ORDER BY created_at DESC LIMIT 1',
    [ticker]
  );
}

function getLatestPredictions(limit = 20) {
  return query(`
    SELECT p.*, i.name, i.type,
      (SELECT c.close FROM candles c WHERE c.ticker = p.ticker ORDER BY c.date DESC LIMIT 1) as lastClose
    FROM predictions p
    JOIN instruments i ON i.ticker = p.ticker
    WHERE p.id IN (
      SELECT MAX(id) FROM predictions GROUP BY ticker
    )
    ORDER BY p.confidence DESC
    LIMIT ?
  `, [limit]).map(p => {
    // Compute target prices for Bull / Base / Bear scenarios
    const lc = p.lastClose;
    return {
      ...p,
      targetPriceBull: lc != null && p.scenario_bull != null ? Math.round(lc * (1 + p.scenario_bull) * 100) / 100 : null,
      targetPriceBase: lc != null && p.scenario_base != null ? Math.round(lc * (1 + p.scenario_base) * 100) / 100 : null,
      targetPriceBear: lc != null && p.scenario_bear != null ? Math.round(lc * (1 + p.scenario_bear) * 100) / 100 : null,
    };
  });
}

// ============================================================
// RULE-BASED PREDICTION (ensemble member)
// ============================================================
function ruleBasedPrediction(f) {
  let bullScore = 0, bearScore = 0;
  const signals = [];

  // RSI
  if (f.rsi14 < 30) { bullScore += 0.3; signals.push('RSI oversold'); }
  else if (f.rsi14 > 70) { bearScore += 0.3; signals.push('RSI overbought'); }
  else if (f.rsi14 >= 40 && f.rsi14 <= 60) { bullScore += 0.1; }

  // MACD
  if (f.macd_hist > 0) { bullScore += 0.2; signals.push('MACD positive'); }
  else if (f.macd_hist < 0) { bearScore += 0.2; signals.push('MACD negative'); }

  // SMA crossover
  if (f.sma50 && f.sma200) {
    if (f.sma50 > f.sma200) { bullScore += 0.25; signals.push('Golden cross'); }
    else { bearScore += 0.25; signals.push('Death cross'); }
  }

  // Bollinger position
  if (f.bb_lower && f.sma20) {
    const lastClose = f.sma20; // approximate
    if (lastClose < f.bb_lower) { bullScore += 0.15; signals.push('Below BB lower'); }
    if (lastClose > f.bb_upper) { bearScore += 0.15; signals.push('Above BB upper'); }
  }

  // Volume trend
  if (f.volume_ratio > 1.5) { bullScore += 0.1; signals.push('High volume'); }

  // Momentum
  if (f.momentum_1m > 0.05) { bullScore += 0.15; }
  else if (f.momentum_1m < -0.05) { bearScore += 0.15; }

  // -- New features (5-10d horizon) --

  // Pivot support/resistance
  if (f.pivot_pp && f.sma20) {
    if (f.sma20 > f.pivot_r1) { bullScore += 0.15; signals.push('Above Pivot R1'); }
    else if (f.sma20 < f.pivot_s1) { bearScore += 0.15; signals.push('Below Pivot S1'); }
    if (f.sma20 > f.pivot_pp) { bullScore += 0.05; }
    else { bearScore += 0.05; }
  }

  // Short momentum (5d / 10d)
  if (f.momentum_5d > 0.02) { bullScore += 0.12; signals.push('Mom 5d positive'); }
  else if (f.momentum_5d < -0.02) { bearScore += 0.12; signals.push('Mom 5d negative'); }

  if (f.momentum_10d > 0.03) { bullScore += 0.08; }
  else if (f.momentum_10d < -0.03) { bearScore += 0.08; }

  // VWAP proxy
  if (f.vwap_proxy && f.sma20) {
    if (f.sma20 > f.vwap_proxy) { bullScore += 0.08; signals.push('Above VWAP'); }
    else { bearScore += 0.08; signals.push('Below VWAP'); }
  }

  // Relative strength vs WIG
  if (f.relative_strength > 0.02) { bullScore += 0.12; signals.push('Outperforms WIG'); }
  else if (f.relative_strength < -0.02) { bearScore += 0.12; signals.push('Underperforms WIG'); }

  const total = bullScore + bearScore || 1;
  const upProb = bullScore / total;
  const downProb = bearScore / total;
  const expectedReturn = (bullScore - bearScore) * 0.03; // rough scale

  return { upProb, downProb, expectedReturn, signals };
}

// ============================================================
// HELPERS
// ============================================================
function normalizeInputs(f) {
  // Normalize all features to ~0-1 range for neural network
  // 18 inputs: 13 original + 5 new (pivot, vwap, mom5d, mom10d, relStrength)
  if (f.rsi14 == null) return null;

  const raw = {
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
    sma_cross: f.sma50 && f.sma200
      ? (f.sma50 > f.sma200 ? 1 : 0) : 0.5,
    regime_bull: f.regime === 'bullish' ? 1 : 0,
    regime_bear: f.regime === 'bearish' ? 1 : 0,
    // -- New features for 5-10d profit horizon --
    pivot_pos: f.pivot_pp ? Math.tanh(((f.sma20 || 0) - f.pivot_pp) / (Math.abs(f.pivot_r1 - f.pivot_s1) || 1)) : 0,
    vwap_dist: f.vwap_proxy ? Math.tanh(((f.sma20 || 0) - f.vwap_proxy) / (f.vwap_proxy || 1) * 10) : 0,
    mom5d: Math.tanh((f.momentum_5d || 0) * 8),
    mom10d: Math.tanh((f.momentum_10d || 0) * 5),
    rel_strength: Math.tanh((f.relative_strength || 0) * 5),
  };

  // Guard: replace any NaN/Infinity with 0 to prevent NN corruption
  for (const key of Object.keys(raw)) {
    if (!Number.isFinite(raw[key])) raw[key] = 0;
  }

  return raw;
}

function r4(v) { return v != null ? Math.round(v * 10000) / 10000 : null; }

/**
 * Load previously trained models from model_registry on server startup.
 * Restores trainedNets so predictions use NN instead of rules-only.
 */
function loadModelsFromDb() {
  const models = query(
    "SELECT model_name, version, weights, config FROM model_registry WHERE status = 'active' ORDER BY created_at DESC"
  );
  let loaded = 0;
  const seen = new Set();
  for (const m of models) {
    // Only load the latest model per ticker
    if (seen.has(m.model_name)) continue;
    seen.add(m.model_name);
    if (!m.weights) continue;
    try {
      const json = JSON.parse(m.weights);
      const net = NeuralNetwork.fromJSON(json);
      trainedNets[m.model_name] = net;
      loaded++;
    } catch (e) {
      console.warn(`[ml] Failed to load model for ${m.model_name}:`, e.message);
    }
  }
  if (loaded > 0) {
    currentModelVersion = models[0]?.version || null;
    console.log(`[ml] Loaded ${loaded} trained models from DB`);
  }
}

module.exports = {
  trainForTicker, trainAll,
  predict, predictAll,
  getLatestPrediction, getLatestPredictions,
  loadModelsFromDb,
};
