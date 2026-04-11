// ============================================================
// Screening / Ranking engine – Aggressive Daily Top 5
//
// Multi-component scoring system for 1-3 day swing picks.
// 4 score components × dynamic regime-based weights:
//   1. signalScore       – momentum, breakout, trend, RS
//   2. executionScore    – liquidity, turnover, volume spike
//   3. riskAdjustedScore – DD, adaptive vol, Sharpe-like
//   4. modelQualityScore – ML confidence, direction alignment
//
// Hard filters: min liquidity, min data, min freshness.
// Dynamic weights: bullish→momentum, bearish→risk, volatile→liquidity.
// ============================================================
const { query, queryOne, run, saveDb } = require('../db/connection');
const { sma, ema, rsi, maxDrawdown, volatility } = require('../../../../packages/shared/src');
const { calculateStopLevels, computeSellLevels } = require('../ml/riskEngine');
const { getSector, getSectorPeers } = require('../data/sectors');

// ============================================================
// QUALITY GATES – pick must pass ALL to be published
// ============================================================
const QUALITY_GATES = {
  minConfidence: 0.55,        // ML confidence threshold (offensive: raised from 0.45)
  minExpectedReturn: 0.015,   // >1.5% expected return (offensive: raised from 1.0%)
  minLiquidityScore: 0.3,     // execution score threshold
  minCompositeScore: 35,      // overall composite score (offensive: raised from 30)
  maxConcurrentPicks: 5,      // hard cap on published signals
  maxSectorConcentration: 2,  // max picks from same sector
};

// ============================================================
// HARD FILTERS – ticker must pass ALL to enter ranking
// Type-aware: FUTURES have different liquidity thresholds
// Warm-up mode: if ticker has ≥20 candles but <minCandles,
//   use relaxed thresholds so new tickers can enter ranking.
// ============================================================
const FILTERS = {
  STOCK: { minCandles: 60, minAvgDailyVolume: 10000, minAvgDailyTurnover: 50000, minDataFreshnessDays: 5 },
  ETF:   { minCandles: 60, minAvgDailyVolume: 5000,  minAvgDailyTurnover: 30000, minDataFreshnessDays: 5 },
  FUTURES:{ minCandles: 40, minAvgDailyVolume: 500,   minAvgDailyTurnover: 100000,minDataFreshnessDays: 5 },
  INDEX: { minCandles: 60, minAvgDailyVolume: 0,      minAvgDailyTurnover: 0,     minDataFreshnessDays: 5 },
};
const WARMUP_FILTERS = {
  STOCK: { minCandles: 20, minAvgDailyVolume: 5000,  minAvgDailyTurnover: 20000, minDataFreshnessDays: 5 },
  ETF:   { minCandles: 20, minAvgDailyVolume: 2000,  minAvgDailyTurnover: 10000, minDataFreshnessDays: 5 },
  FUTURES:{ minCandles: 15, minAvgDailyVolume: 200,   minAvgDailyTurnover: 50000, minDataFreshnessDays: 5 },
  INDEX: { minCandles: 20, minAvgDailyVolume: 0,      minAvgDailyTurnover: 0,     minDataFreshnessDays: 5 },
};
function getFilters(type, candleCount) {
  const full = FILTERS[type] || FILTERS.STOCK;
  if (candleCount >= full.minCandles) return full;
  return WARMUP_FILTERS[type] || WARMUP_FILTERS.STOCK;
}

// ============================================================
// REGIME-DEPENDENT WEIGHT PROFILES (aggressive style)
// ============================================================
const WEIGHT_PROFILES = {
  bullish:  { signal: 0.45, execution: 0.15, risk: 0.15, model: 0.25 },
  bearish:  { signal: 0.25, execution: 0.20, risk: 0.35, model: 0.20 },
  volatile: { signal: 0.30, execution: 0.25, risk: 0.25, model: 0.20 },
  neutral:  { signal: 0.35, execution: 0.20, risk: 0.20, model: 0.25 },
};

// ============================================================
// MAIN API
// ============================================================

/**
 * Run the screener and persist results.
 * @returns {Array} sorted ranking entries with 4-component breakdown
 */
function runScreener() {
  const instruments = query(
    "SELECT ticker, name, type FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','FUTURES')"
  );

  const regime = detectMarketRegime();
  const weights = WEIGHT_PROFILES[regime] || WEIGHT_PROFILES.neutral;
  const rankings = [];

  for (const inst of instruments) {
    const candles = query(
      'SELECT date, open, high, low, close, volume FROM candles WHERE ticker = ? ORDER BY date ASC',
      [inst.ticker]
    );

    // ---- Type-aware hard filters (with warm-up for short history) ----
    const f = getFilters(inst.type, candles.length);
    if (candles.length < f.minCandles) continue;

    const lastDate = candles[candles.length - 1].date;
    if (businessDaysSince(lastDate) > f.minDataFreshnessDays) continue;

    const avgVol20 = avgVolume(candles, 20);
    if (avgVol20 < f.minAvgDailyVolume) continue;

    const lastClose = candles[candles.length - 1].close;
    if (avgVol20 * lastClose < f.minAvgDailyTurnover) continue;

    // ---- ML prediction (if available) ----
    const prediction = queryOne(
      'SELECT confidence, predicted_direction, predicted_return FROM predictions WHERE ticker = ? ORDER BY created_at DESC LIMIT 1',
      [inst.ticker]
    );

    // ---- Latest feature row ----
    const features = queryOne(
      'SELECT * FROM features WHERE ticker = ? ORDER BY date DESC LIMIT 1',
      [inst.ticker]
    );

    // ---- Compute 4 component scores ----
    const signal    = computeSignalScore(candles, features);
    const execution = computeExecutionScore(candles);
    const risk      = computeRiskAdjustedScore(candles, features);
    const model     = computeModelQualityScore(inst.ticker, prediction, features);

    const total = round(
      (signal.score * weights.signal +
       execution.score * weights.execution +
       risk.score * weights.risk +
       model.score * weights.model) * 100
    );

    const allMetrics = {
      ...signal.metrics,
      ...execution.metrics,
      ...risk.metrics,
      ...model.metrics,
      lastClose: round(lastClose),
      regime,
    };

    const reasons = [
      ...signal.reasons,
      ...execution.reasons,
      ...risk.reasons,
      ...model.reasons,
    ];

    rankings.push({
      ticker: inst.ticker,
      name: inst.name,
      type: inst.type,
      score: total,
      components: {
        signal: round(signal.score * 100),
        execution: round(execution.score * 100),
        risk: round(risk.score * 100),
        model: round(model.score * 100),
      },
      weights,
      metrics: allMetrics,
      reason: reasons.length > 0 ? reasons.join('; ') : 'Umiarkowane wskaźniki',
    });
  }

  rankings.sort((a, b) => b.score - a.score);

  // Persist to DB
  for (const r of rankings) {
    run(
      'INSERT INTO rankings (ticker, score, metrics, reason) VALUES (?, ?, ?, ?)',
      [r.ticker, r.score,
       JSON.stringify({ components: r.components, weights: r.weights, ...r.metrics }),
       r.reason]
    );
  }

  saveDb();
  console.log(`[screener] Ranked ${rankings.length} instruments (regime=${regime}, w:sig=${weights.signal} exe=${weights.execution} rsk=${weights.risk} mdl=${weights.model})`);
  return rankings;
}

// ============================================================
// 1. SIGNAL SCORE – momentum, breakout, trend, alignment
//    Sub-metrics: 8 indicators → weighted composite
// ============================================================
function computeSignalScore(candles, features) {
  const len = candles.length;
  const last = candles[len - 1].close;
  const reasons = [];

  // --- Multi-horizon momentum ---
  const perf1D  = len >= 2   ? (last - candles[len - 2].close)  / candles[len - 2].close  : 0;
  const perf5D  = len >= 6   ? (last - candles[len - 6].close)  / candles[len - 6].close  : 0;
  const perf10D = len >= 11  ? (last - candles[len - 11].close) / candles[len - 11].close : 0;
  const perf1M  = len >= 21  ? (last - candles[len - 21].close) / candles[len - 21].close : 0;
  const perf3M  = len >= 63  ? (last - candles[len - 63].close) / candles[len - 63].close : 0;

  const shortMom = normalize(perf1D * 0.3 + perf5D * 0.4 + perf10D * 0.3, -0.10, 0.15);
  const medMom   = normalize(perf1M * 0.6 + perf3M * 0.4, -0.30, 0.50);
  const momentumScore = shortMom * 0.6 + medMom * 0.4;

  if (shortMom > 0.7) reasons.push('Silny krótkoterminowy momentum');
  if (medMom > 0.7) reasons.push('Silny średnioterminowy momentum');

  // --- ROC acceleration ---
  const rocAccel = perf5D - perf10D / 2;
  const rocScore = normalize(rocAccel, -0.05, 0.05);

  // --- Breakout detection (position within 20D high/low) ---
  const high20 = Math.max(...candles.slice(-20).map(c => c.high));
  const low20  = Math.min(...candles.slice(-20).map(c => c.low));
  const range20 = high20 - low20 || 1;
  const breakoutPct = (last - low20) / range20;
  const breakoutScore = normalize(breakoutPct, 0.3, 1.0);
  if (breakoutPct > 0.95) reasons.push('Breakout powyżej 20D high');

  // --- Trend strength – SMA alignment ---
  const sma20Val  = sma(candles, 20);
  const sma50Val  = len >= 50  ? sma(candles, 50)  : null;
  const sma200Val = len >= 200 ? sma(candles, 200) : null;
  let trendScore = 0.5;
  if (sma20Val && sma50Val && sma200Val) {
    if (last > sma20Val && sma20Val > sma50Val && sma50Val > sma200Val) trendScore = 1.0;
    else if (last > sma50Val && sma50Val > sma200Val) trendScore = 0.8;
    else if (last > sma200Val) trendScore = 0.6;
    else if (last < sma20Val && sma20Val < sma50Val && sma50Val < sma200Val) trendScore = 0.0;
    else trendScore = 0.3;
  } else if (sma20Val && sma50Val) {
    trendScore = last > sma20Val && sma20Val > sma50Val ? 0.9 : last > sma50Val ? 0.6 : 0.3;
  }
  if (trendScore >= 0.9) reasons.push('Perfekcyjny uptrend (SMA alignment)');

  // --- MACD histogram momentum ---
  let macdScore = 0.5;
  if (features) {
    if (features.macd_hist > 0 && features.macd > 0) macdScore = 0.9;
    else if (features.macd_hist > 0) macdScore = 0.7;
    else if (features.macd_hist < 0 && features.macd < 0) macdScore = 0.1;
    else macdScore = 0.3;
  }

  // --- RSI momentum (aggressive: prefer 50-70, bonus if rsi7>rsi14) ---
  let rsiMomScore = 0.5;
  if (features && features.rsi14 != null) {
    const rsi14 = features.rsi14;
    const rsi7  = features.rsi7 || rsi14;
    if (rsi14 >= 50 && rsi14 <= 70) rsiMomScore = 0.9;
    else if (rsi14 >= 40 && rsi14 <= 80) rsiMomScore = 0.6;
    else if (rsi14 < 30) rsiMomScore = 0.7; // oversold bounce
    else rsiMomScore = 0.2;
    if (rsi7 > rsi14 + 5) rsiMomScore = Math.min(rsiMomScore + 0.15, 1.0);
  }

  // --- Bollinger %B ---
  let bbScore = 0.5;
  if (features && features.bb_upper && features.bb_lower) {
    const bbRange = features.bb_upper - features.bb_lower;
    if (bbRange > 0) bbScore = normalize((last - features.bb_lower) / bbRange, 0.2, 0.9);
  }

  // --- Price distance from SMA20 (mean reversion risk) ---
  let distScore = 0.5;
  if (sma20Val) {
    const dist = (last - sma20Val) / sma20Val;
    if (dist >= 0 && dist <= 0.05) distScore = 1.0;
    else if (dist > 0.05 && dist <= 0.10) distScore = 0.7;
    else if (dist > 0.10) distScore = 0.3;
    else if (dist < -0.05) distScore = 0.4;
    else distScore = 0.6;
  }

  const score = (
    momentumScore * 0.25 +
    rocScore      * 0.10 +
    breakoutScore * 0.15 +
    trendScore    * 0.15 +
    macdScore     * 0.10 +
    rsiMomScore   * 0.10 +
    bbScore       * 0.08 +
    distScore     * 0.07
  );

  return {
    score: clamp(score),
    metrics: {
      perf1D: round(perf1D * 100), perf5D: round(perf5D * 100),
      perf10D: round(perf10D * 100), perf1M: round(perf1M * 100),
      perf3M: round(perf3M * 100),
      momentumScore: round(momentumScore * 100),
      rocAccel: round(rocAccel * 100),
      breakoutPct: round(breakoutPct * 100),
      trendScore: round(trendScore * 100),
      macdScore: round(macdScore * 100),
      rsiMomScore: round(rsiMomScore * 100),
      rsi14: features?.rsi14 != null ? round(features.rsi14) : null,
      rsi7: features?.rsi7 != null ? round(features.rsi7) : null,
      bbScore: round(bbScore * 100),
      sma20: sma20Val ? round(sma20Val) : null,
      sma50: sma50Val ? round(sma50Val) : null,
      sma200: sma200Val ? round(sma200Val) : null,
    },
    reasons,
  };
}

// ============================================================
// 2. EXECUTION SCORE – liquidity, tradability
//    Sub-metrics: turnover, vol trend, spike, spread proxy
// ============================================================
function computeExecutionScore(candles) {
  const len = candles.length;
  const last = candles[len - 1];
  const reasons = [];

  // Average daily turnover (PLN)
  const turnover20 = avgTurnover(candles, 20);
  const turnoverScore = normalize(turnover20, 100000, 5000000);
  if (turnover20 > 2000000) reasons.push('Wysoka płynność (>2M PLN/dzień)');

  // Volume trend 10D vs 30D
  const vol10 = candles.slice(-Math.min(10, len)).reduce((s, c) => s + c.volume, 0) / Math.min(10, len);
  const vol30 = candles.slice(-Math.min(30, len)).reduce((s, c) => s + c.volume, 0) / Math.min(30, len);
  const volRatio = vol30 > 0 ? vol10 / vol30 : 1;
  const volTrendScore = normalize(volRatio, 0.5, 2.0);
  if (volRatio > 1.5) reasons.push('Rosnący wolumen (+50%)');

  // Volume spike (last bar vs 20D avg)
  const avgVol20 = avgVolume(candles, 20);
  const volSpike = avgVol20 > 0 ? last.volume / avgVol20 : 1;
  const spikeScore = normalize(volSpike, 0.5, 3.0);
  if (volSpike > 2.0) reasons.push('Spike wolumenu (>2x średniej)');

  // Spread proxy (avg daily range / close)
  const spreadProxy20 = candles.slice(-20).reduce((s, c) => s + (c.high - c.low) / c.close, 0) / 20;
  let spreadScore = 0.5;
  if (spreadProxy20 >= 0.005 && spreadProxy20 <= 0.03) spreadScore = 1.0;
  else if (spreadProxy20 > 0.03 && spreadProxy20 <= 0.06) spreadScore = 0.7;
  else if (spreadProxy20 > 0.06) spreadScore = 0.3;
  else spreadScore = 0.4;

  const score = (
    turnoverScore  * 0.35 +
    volTrendScore  * 0.25 +
    spikeScore     * 0.20 +
    spreadScore    * 0.20
  );

  return {
    score: clamp(score),
    metrics: {
      avgTurnover20: round(turnover20),
      volumeRatio: round(volRatio),
      volumeSpike: round(volSpike),
      spreadProxy: round(spreadProxy20 * 100),
    },
    reasons,
  };
}

// ============================================================
// 3. RISK-ADJUSTED SCORE – DD, adaptive vol, Sharpe-like
//    Sub-metrics: DD20, DD60, adaptive vol, downside dev,
//                 Sharpe-like, ATR risk
// ============================================================
function computeRiskAdjustedScore(candles, features) {
  const len = candles.length;
  const last = candles[len - 1].close;
  const reasons = [];

  // Short-term drawdown 20D
  const dd20 = maxDrawdown(candles.slice(-20));
  const dd20Score = 1.0 - normalize(dd20, 0.0, 0.15);

  // Medium-term drawdown 60D
  const dd60 = maxDrawdown(candles.slice(-60));
  const dd60Score = 1.0 - normalize(dd60, 0.0, 0.30);
  if (dd20 < 0.03) reasons.push('Bardzo niski DD 20D (<3%)');

  // Adaptive volatility: vol5D vs vol20D (decreasing = consolidation)
  const closes6 = candles.slice(-6);
  const vol5  = closes6.length >= 5 ? volatility(closes6, 5) || 0.3 : 0.3;
  const vol20 = volatility(candles, 20) || 0.3;
  const volRatioAdaptive = vol20 > 0 ? vol5 / vol20 : 1.0;
  const adaptiveVolScore = normalize(2.0 - volRatioAdaptive, 0.5, 1.5);
  if (volRatioAdaptive < 0.7) reasons.push('Zmienność maleje (konsolidacja)');

  // Downside deviation (20D)
  const returns = [];
  for (let i = 1; i < Math.min(21, len); i++) {
    returns.push((candles[len - i].close - candles[len - i - 1].close) / candles[len - i - 1].close);
  }
  const negReturns = returns.filter(r => r < 0);
  const downsideDev = negReturns.length > 0
    ? Math.sqrt(negReturns.reduce((s, r) => s + r * r, 0) / negReturns.length)
    : 0;
  const downsideScore = 1.0 - normalize(downsideDev, 0.0, 0.04);

  // Sharpe-like ratio
  const ret20D = len >= 21 ? (last - candles[len - 21].close) / candles[len - 21].close : 0;
  const annRet = ret20D * 12;
  const annVol = vol20 || 0.3;
  const sharpe = annVol > 0 ? (annRet - 0.0575) / annVol : 0;
  const sharpeScore = normalize(sharpe, -1.0, 3.0);
  if (sharpe > 1.5) reasons.push('Wysoki Sharpe-like ratio');

  // ATR-based risk per share
  let atrRiskScore = 0.5;
  if (features?.atr14 && last > 0) {
    const atrPct = features.atr14 / last;
    if (atrPct >= 0.015 && atrPct <= 0.04) atrRiskScore = 1.0;
    else if (atrPct >= 0.01 && atrPct <= 0.06) atrRiskScore = 0.7;
    else if (atrPct > 0.06) atrRiskScore = 0.3;
    else atrRiskScore = 0.4;
  }

  const score = (
    dd20Score        * 0.20 +
    dd60Score        * 0.15 +
    adaptiveVolScore * 0.15 +
    downsideScore    * 0.15 +
    sharpeScore      * 0.20 +
    atrRiskScore     * 0.15
  );

  return {
    score: clamp(score),
    metrics: {
      maxDD20: round(dd20 * 100),
      maxDD60: round(dd60 * 100),
      vol5D: round(vol5 * 100),
      vol20D: round(vol20 * 100),
      volRatio5_20: round(volRatioAdaptive),
      downsideDev: round(downsideDev * 100),
      sharpeLike: round(sharpe),
      atr14: features?.atr14 != null ? round(features.atr14) : null,
    },
    reasons,
  };
}

// ============================================================
// 4. MODEL QUALITY SCORE – ML confidence, direction alignment,
//    model accuracy, model freshness
// ============================================================
function computeModelQualityScore(ticker, prediction, features) {
  const reasons = [];

  // ML confidence
  let confScore = 0.3;
  if (prediction?.confidence != null) {
    confScore = normalize(prediction.confidence, 0.0, 0.8);
    if (prediction.confidence > 0.5) reasons.push(`Wysoka pewność modelu (${round(prediction.confidence * 100)}%)`);
  }

  // ML direction alignment with technicals
  let alignScore = 0.5;
  if (prediction?.predicted_direction && features) {
    const mlBull = prediction.predicted_direction === 'BUY';
    const technicalBull = (features.macd_hist > 0) && (features.rsi14 > 50);
    const technicalBear = (features.macd_hist < 0) && (features.rsi14 < 50);

    if (mlBull && technicalBull) { alignScore = 1.0; reasons.push('ML + technicals zgodne (BUY)'); }
    else if (!mlBull && technicalBear) alignScore = 0.8;
    else if (mlBull && technicalBear) alignScore = 0.2;
    else if (!mlBull && technicalBull) alignScore = 0.2;
    else alignScore = 0.5;
  }

  // ML predicted return
  let returnScore = 0.5;
  if (prediction?.predicted_return != null) {
    returnScore = normalize(prediction.predicted_return, -0.05, 0.10);
  }

  // Model freshness & accuracy from model_registry
  const latestModel = queryOne(
    "SELECT accuracy, created_at FROM model_registry WHERE model_name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    [ticker]
  );
  let modelFreshnessScore = 0.3;
  let accuracyScore = 0.3;
  if (latestModel) {
    const age = daysSince(latestModel.created_at);
    modelFreshnessScore = 1.0 - normalize(age, 0, 30);
    accuracyScore = normalize(latestModel.accuracy || 0.5, 0.40, 0.75);
    if (latestModel.accuracy > 0.60) reasons.push(`Dokładność modelu: ${round(latestModel.accuracy * 100)}%`);
  }

  const score = (
    confScore           * 0.30 +
    alignScore          * 0.25 +
    returnScore         * 0.15 +
    accuracyScore       * 0.20 +
    modelFreshnessScore * 0.10
  );

  return {
    score: clamp(score),
    metrics: {
      mlConfidence: prediction?.confidence != null ? round(prediction.confidence * 100) : null,
      mlDirection: prediction?.predicted_direction || null,
      mlReturn: prediction?.predicted_return != null ? round(prediction.predicted_return * 100) : null,
      modelAccuracy: latestModel?.accuracy != null ? round(latestModel.accuracy * 100) : null,
      alignmentScore: round(alignScore * 100),
    },
    reasons,
  };
}

// ============================================================
// REGIME DETECTION
// ============================================================
function detectMarketRegime() {
  const wig = queryOne(
    "SELECT regime FROM features WHERE ticker = 'WIG20' ORDER BY date DESC LIMIT 1"
  );
  if (wig?.regime) return wig.regime;

  const regimes = query(
    "SELECT regime, COUNT(*) as cnt FROM features WHERE date = (SELECT MAX(date) FROM features) GROUP BY regime ORDER BY cnt DESC LIMIT 1"
  );
  return regimes[0]?.regime || 'neutral';
}

// ============================================================
// DAILY PICKS – Top 5 with risk integration
// ============================================================
function getDailyPicks(opts = {}) {
  const { assetTypes = ['STOCK', 'ETF', 'FUTURES'], limit = 5 } = opts;
  const ranking = getLatestRanking(50);
  if (ranking.length === 0) return { picks: [], regime: 'neutral', generatedAt: null, qualityGates: QUALITY_GATES };

  // --- Phase 1: Build candidates with edge score ---
  const candidates = [];
  for (const r of ranking) {
    if (!assetTypes.includes(r.type)) continue;

    const pred = queryOne(
      'SELECT * FROM predictions WHERE ticker = ? ORDER BY created_at DESC LIMIT 1',
      [r.ticker]
    );

    const candles = query(
      'SELECT date, open, high, low, close, volume FROM candles WHERE ticker = ? ORDER BY date ASC',
      [r.ticker]
    );
    if (candles.length < 2) continue;

    const last = candles[candles.length - 1];
    const entryPrice = last.close;

    const confidence = pred?.confidence || 0;
    const expectedReturn = pred?.predicted_return || 0;
    const executionScore = (r.metrics?.components?.execution || 50) / 100;

    // Relative strength from features
    const feat = queryOne(
      'SELECT relative_strength, sector_rs FROM features WHERE ticker = ? ORDER BY date DESC LIMIT 1',
      [r.ticker]
    );
    const rs = feat?.relative_strength || 0;
    const sectorRs = feat?.sector_rs || 0;

    // Edge score: confidence × expectedReturn × RS boost × liquidity
    const rsBoost = 1 + Math.max(rs, 0) + Math.max(sectorRs, 0) * 0.5;
    const edgeScore = round(confidence * Math.max(expectedReturn, 0) * rsBoost * executionScore * 10000);

    candidates.push({
      ...r, pred, candles, entryPrice, confidence, expectedReturn,
      executionScore, rs, sectorRs, edgeScore,
      sector: getSector(r.ticker),
    });
  }

  // --- Phase 2: Quality gate filtering ---
  const gated = [];
  const rejected = [];
  for (const c of candidates) {
    const reasons = [];
    if (c.confidence < QUALITY_GATES.minConfidence) reasons.push(`confidence ${(c.confidence*100).toFixed(0)}% < ${QUALITY_GATES.minConfidence*100}%`);
    if (c.expectedReturn < QUALITY_GATES.minExpectedReturn) reasons.push(`expectedReturn ${(c.expectedReturn*100).toFixed(1)}% < ${(QUALITY_GATES.minExpectedReturn*100).toFixed(1)}%`);
    if (c.executionScore < QUALITY_GATES.minLiquidityScore) reasons.push(`liquidity ${(c.executionScore*100).toFixed(0)}% < ${QUALITY_GATES.minLiquidityScore*100}%`);
    if (c.score < QUALITY_GATES.minCompositeScore) reasons.push(`score ${c.score} < ${QUALITY_GATES.minCompositeScore}`);
    if (c.pred?.predicted_direction === 'SELL') reasons.push('direction=SELL');
    if (reasons.length > 0) {
      rejected.push({ ticker: c.ticker, reasons });
    } else {
      gated.push(c);
    }
  }

  // --- Phase 3: Sort by edge score (best alpha first), sector-cap ---
  gated.sort((a, b) => b.edgeScore - a.edgeScore);

  const picks = [];
  const sectorCount = {};
  for (const c of gated) {
    if (picks.length >= Math.min(limit, QUALITY_GATES.maxConcurrentPicks)) break;
    // Sector concentration limit
    const sec = c.sector;
    sectorCount[sec] = (sectorCount[sec] || 0);
    if (sectorCount[sec] >= QUALITY_GATES.maxSectorConcentration) continue;
    sectorCount[sec]++;

    const sellLevels = computeSellLevels(c.ticker, c.entryPrice);
    const growth = computeGrowth(c.candles);

    const ml = c.pred ? {
      direction: c.pred.predicted_direction,
      confidence: round((c.confidence) * 100),
      expectedReturn: round((c.expectedReturn) * 100),
      scenarios: {
        bull: round((c.pred.scenario_bull || 0) * 100),
        base: round((c.pred.scenario_base || 0) * 100),
        bear: round((c.pred.scenario_bear || 0) * 100),
      },
    } : null;

    picks.push({
      rank: picks.length + 1,
      ticker: c.ticker,
      name: c.name,
      type: c.type,
      sector: c.sector,
      compositeScore: c.score,
      edgeScore: c.edgeScore,
      components: c.metrics?.components || null,
      metrics: c.metrics,
      reasons: c.reason,
      ml,
      sell: sellLevels,
      growth,
      relativeStrength: round(c.rs * 100),
      sectorRelativeStrength: round(c.sectorRs * 100),
      holdDays: '1-3',
      maxHoldDays: 40,
    });
  }

  // Total active instruments in universe (before any filtering)
  const universeRow = queryOne(
    "SELECT COUNT(*) AS cnt FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','FUTURES')"
  );
  const universeTotal = universeRow?.cnt || 0;

  return {
    picks,
    regime: ranking[0]?.metrics?.regime || 'neutral',
    rankedAt: ranking[0]?.ranked_at || null,
    universeTotal,
    totalScreened: ranking.length,
    totalCandidates: candidates.length,
    passedGates: gated.length,
    rejectedGates: rejected,
    qualityGates: QUALITY_GATES,
    generatedAt: ranking[0]?.ranked_at || null,
  };
}

/**
 * Futures-only picks — same logic but filtered to FUTURES type.
 */
function getFuturesPicks(limit = 5) {
  return getDailyPicks({ assetTypes: ['FUTURES'], limit });
}

/**
 * Best-to-invest-now — combined stocks + futures ranked by expected value.
 */
function getBestToInvest(limit = 10) {
  const stocks = getDailyPicks({ assetTypes: ['STOCK', 'ETF'], limit: 10 });
  const futures = getDailyPicks({ assetTypes: ['FUTURES'], limit: 5 });

  // Merge and re-rank by (compositeScore * confidence) — expected value
  const all = [...stocks.picks, ...futures.picks].map(p => ({
    ...p,
    expectedValue: round(p.compositeScore * (p.ml?.confidence || 50) / 100),
  }));
  all.sort((a, b) => b.expectedValue - a.expectedValue);

  const top = all.slice(0, limit);
  top.forEach((p, i) => { p.rank = i + 1; });

  return {
    picks: top,
    regime: stocks.regime,
    rankedAt: stocks.rankedAt || futures.rankedAt || null,
    generatedAt: stocks.rankedAt || futures.rankedAt || null,
    totalStocks: stocks.picks.length,
    totalFutures: futures.picks.length,
  };
}

// ============================================================
// DAILY / WEEKLY GROWTH
// ============================================================
function computeGrowth(candles) {
  const len = candles.length;
  const last = candles[len - 1].close;

  const dailyGrowthPct = len >= 2
    ? round((last - candles[len - 2].close) / candles[len - 2].close * 100) : 0;
  const weeklyGrowthPct = len >= 6
    ? round((last - candles[len - 6].close) / candles[len - 6].close * 100) : 0;
  const monthlyGrowthPct = len >= 22
    ? round((last - candles[len - 22].close) / candles[len - 22].close * 100) : 0;

  return { dailyGrowthPct, weeklyGrowthPct, monthlyGrowthPct };
}

/**
 * Growth report — daily/weekly changes for all ranked instruments.
 */
function getDailyGrowthReport() {
  const instruments = query(
    "SELECT ticker, name, type FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','FUTURES')"
  );

  const report = [];
  for (const inst of instruments) {
    const candles = query(
      'SELECT date, close, volume FROM candles WHERE ticker = ? ORDER BY date ASC',
      [inst.ticker]
    );
    if (candles.length < 2) continue;

    const growth = computeGrowth(candles);
    const last = candles[candles.length - 1];

    report.push({
      ticker: inst.ticker,
      name: inst.name,
      type: inst.type,
      lastClose: round(last.close),
      lastDate: last.date,
      ...growth,
    });
  }

  // Sort by daily growth descending
  report.sort((a, b) => b.dailyGrowthPct - a.dailyGrowthPct);

  return {
    date: new Date().toISOString().split('T')[0],
    total: report.length,
    topGainers: report.slice(0, 10),
    topLosers: report.slice(-10).reverse(),
    all: report,
  };
}

function getWeeklyGrowthReport() {
  const instruments = query(
    "SELECT ticker, name, type FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','FUTURES')"
  );

  const report = [];
  for (const inst of instruments) {
    const candles = query(
      'SELECT date, close FROM candles WHERE ticker = ? ORDER BY date ASC',
      [inst.ticker]
    );
    if (candles.length < 6) continue;

    const growth = computeGrowth(candles);
    const last = candles[candles.length - 1];

    report.push({
      ticker: inst.ticker,
      name: inst.name,
      type: inst.type,
      lastClose: round(last.close),
      ...growth,
    });
  }

  report.sort((a, b) => b.weeklyGrowthPct - a.weeklyGrowthPct);

  return {
    date: new Date().toISOString().split('T')[0],
    total: report.length,
    topGainers: report.slice(0, 10),
    topLosers: report.slice(-10).reverse(),
    all: report,
  };
}

// ============================================================
// EX-POST VALIDATION
// ============================================================

function saveDailyPicks(picks) {
  const today = new Date().toISOString().split('T')[0];
  for (const pick of picks) {
    run(`INSERT OR REPLACE INTO daily_picks
      (ticker, pick_date, rank, composite_score, components, entry_price,
       stop_loss, take_profit, regime, reasons, validated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [pick.ticker, today, pick.rank, pick.compositeScore,
       JSON.stringify(pick.components),
       pick.risk?.entryPrice || null,
       pick.risk?.stopLoss || null,
       pick.risk?.takeProfit || null,
       pick.metrics?.regime || 'neutral',
       pick.reasons]
    );
  }
  saveDb();
  console.log(`[screener] Saved ${picks.length} daily picks for ${today}`);
}

function validatePastPicks() {
  const picksToValidate = query(`
    SELECT * FROM daily_picks
    WHERE validated = 0 AND pick_date <= date('now', '-1 day')
    ORDER BY pick_date ASC LIMIT 25
  `);

  let validated = 0;
  for (const pick of picksToValidate) {
    const futureCandles = query(
      'SELECT date, close, high, low FROM candles WHERE ticker = ? AND date > ? ORDER BY date ASC LIMIT 5',
      [pick.ticker, pick.pick_date]
    );

    if (futureCandles.length < 1) continue;

    const entryPrice = pick.entry_price;
    if (!entryPrice || entryPrice <= 0) continue;

    const ret1D = futureCandles[0] ? (futureCandles[0].close - entryPrice) / entryPrice : null;
    const ret2D = futureCandles[1] ? (futureCandles[1].close - entryPrice) / entryPrice : null;
    const ret3D = futureCandles[2] ? (futureCandles[2].close - entryPrice) / entryPrice : null;

    let mae = 0, mfe = 0;
    for (const fc of futureCandles.slice(0, 3)) {
      const drop = (fc.low - entryPrice) / entryPrice;
      const rise = (fc.high - entryPrice) / entryPrice;
      if (drop < mae) mae = drop;
      if (rise > mfe) mfe = rise;
    }

    run(`UPDATE daily_picks SET
      return_1d = ?, return_2d = ?, return_3d = ?,
      mae = ?, mfe = ?, validated = 1
      WHERE id = ?`,
      [ret1D != null ? round(ret1D * 100) : null,
       ret2D != null ? round(ret2D * 100) : null,
       ret3D != null ? round(ret3D * 100) : null,
       round(mae * 100), round(mfe * 100),
       pick.id]
    );
    validated++;
  }

  if (validated > 0) {
    saveDb();
    console.log(`[screener] Validated ${validated} past picks`);
  }
  return validated;
}

function getPickPerformance(days = 30) {
  return query(`
    SELECT ticker, pick_date, rank, composite_score, entry_price,
           return_1d, return_2d, return_3d, mae, mfe, regime
    FROM daily_picks
    WHERE validated = 1 AND pick_date >= date('now', '-' || ? || ' days')
    ORDER BY pick_date DESC
  `, [days]);
}

function getPickStats(days = 30) {
  const row = queryOne(`
    SELECT
      COUNT(*) as total_picks,
      AVG(return_1d) as avg_ret_1d,
      AVG(return_2d) as avg_ret_2d,
      AVG(return_3d) as avg_ret_3d,
      AVG(mae) as avg_mae,
      AVG(mfe) as avg_mfe,
      SUM(CASE WHEN return_1d > 0 THEN 1 ELSE 0 END) as wins_1d,
      SUM(CASE WHEN return_2d > 0 THEN 1 ELSE 0 END) as wins_2d,
      SUM(CASE WHEN return_3d > 0 THEN 1 ELSE 0 END) as wins_3d
    FROM daily_picks
    WHERE validated = 1 AND pick_date >= date('now', '-' || ? || ' days')
  `, [days]);

  if (!row || row.total_picks === 0) return null;

  return {
    totalPicks: row.total_picks,
    precision1D: round(row.wins_1d / row.total_picks * 100),
    precision2D: round(row.wins_2d / row.total_picks * 100),
    precision3D: round(row.wins_3d / row.total_picks * 100),
    avgReturn1D: round(row.avg_ret_1d),
    avgReturn2D: round(row.avg_ret_2d),
    avgReturn3D: round(row.avg_ret_3d),
    avgMAE: round(row.avg_mae),
    avgMFE: round(row.avg_mfe),
  };
}

// ============================================================
// PERSISTENCE
// ============================================================
function getLatestRanking(limit = 20) {
  const lastRow = queryOne('SELECT MAX(ranked_at) as d FROM rankings');
  const lastDate = lastRow?.d;
  if (!lastDate) return [];

  return query(`
    SELECT r.ticker, i.name, i.type, r.score, r.metrics, r.reason, r.ranked_at
    FROM rankings r
    JOIN instruments i ON i.ticker = r.ticker
    WHERE r.ranked_at = ?
    ORDER BY r.score DESC
    LIMIT ?
  `, [lastDate, limit]).map((row) => {
    const metrics = JSON.parse(row.metrics || '{}');
    return { ...row, metrics, lastClose: metrics.lastClose ?? null };
  });
}

// ============================================================
// HELPERS
// ============================================================
function normalize(val, min, max) {
  if (!Number.isFinite(val)) return 0;
  const range = max - min;
  if (range === 0) return 0.5;
  return Math.max(0, Math.min(1, (val - min) / range));
}

function clamp(v) {
  return Math.max(0, Math.min(1, v));
}

function round(v, d = 2) {
  return v != null ? Math.round(v * 10 ** d) / 10 ** d : null;
}

function avgVolume(candles, days) {
  const slice = candles.slice(-days);
  return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
}

function avgTurnover(candles, days) {
  const slice = candles.slice(-days);
  return slice.reduce((s, c) => s + c.volume * c.close, 0) / slice.length;
}

function businessDaysSince(dateStr) {
  if (!dateStr) return 999;
  const from = new Date(dateStr);
  const now = new Date();
  let count = 0;
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  while (d <= now) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function daysSince(dateStr) {
  if (!dateStr) return 999;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

if (require.main === module) {
  const results = runScreener();
  console.table(results.slice(0, 10).map((r) => ({
    ticker: r.ticker, score: r.score,
    sig: r.components.signal, exe: r.components.execution,
    rsk: r.components.risk, mdl: r.components.model,
    reason: r.reason,
  })));
}

module.exports = {
  runScreener,
  getLatestRanking,
  getDailyPicks,
  getFuturesPicks,
  getBestToInvest,
  getDailyGrowthReport,
  getWeeklyGrowthReport,
  saveDailyPicks,
  validatePastPicks,
  getPickPerformance,
  getPickStats,
};
