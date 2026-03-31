// ============================================================
// Feature Engineering Pipeline
// Computes ML features from raw candle data and stores in DB.
// Runs per-ticker, designed to be called by the 24/7 worker.
// ============================================================
const { query, queryOne, run, saveDb } = require('../db/connection');
const { sma, ema, rsi, volatility, maxDrawdown } = require('../../../../packages/shared/src');
const { getSector, getSectorPeers } = require('../data/sectors');

/**
 * Compute all features for a single ticker and persist.
 */
function computeFeatures(ticker, opts = {}) {
  const candles = query(
    'SELECT date, open, high, low, close, volume FROM candles WHERE ticker = ? ORDER BY date ASC',
    [ticker]
  );

  // Adaptive minimum: FUTURES/INDEX need fewer bars to start generating features
  const inst = queryOne('SELECT type FROM instruments WHERE ticker = ?', [ticker]);
  const isFuturesLike = inst?.type === 'FUTURES' || inst?.type === 'INDEX';
  const minCandles   = isFuturesLike ? 30 : 60;
  const startIdx     = isFuturesLike ? 26 : 50; // computeSingleBar needs >=26

  if (candles.length < minCandles) {
    if (isFuturesLike) console.log(`[features] ${ticker}(${inst.type}): only ${candles.length}/${minCandles} candles – skipped`);
    return 0;
  }

  let inserted = 0;
  const force = opts.force || false;

  // We compute features starting from bar 50 (need ~50 bars for most indicators)
  // SMA200 will be null for bars 50-199, but the ML handles that gracefully
  for (let i = startIdx; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const c = candles[i];

    // Check if already computed (skip if not force)
    if (!force) {
      const existing = queryOne(
        'SELECT 1 FROM features WHERE ticker = ? AND date = ?',
        [ticker, c.date]
      );
      if (existing) continue;
    }

    const feat = computeSingleBar(slice, i, candles);
    if (!feat) continue;

    run(`INSERT OR REPLACE INTO features
      (ticker, date, sma20, sma50, sma200, ema12, ema26,
       rsi14, rsi7, macd, macd_signal, macd_hist,
       bb_upper, bb_middle, bb_lower, atr14, obv, vol_20d,
       momentum_1m, momentum_3m, momentum_6m, volume_ratio, max_dd_60d, regime,
       pivot_r2, pivot_r1, pivot_pp, pivot_s1, pivot_s2,
       vwap_proxy, momentum_5d, momentum_10d,
       gap_pct, range_expansion, vol_accel, close_position, upper_shadow_pct, body_pct)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ticker, c.date,
       feat.sma20, feat.sma50, feat.sma200, feat.ema12, feat.ema26,
       feat.rsi14, feat.rsi7, feat.macd, feat.macd_signal, feat.macd_hist,
       feat.bb_upper, feat.bb_middle, feat.bb_lower, feat.atr14, feat.obv, feat.vol_20d,
       feat.momentum_1m, feat.momentum_3m, feat.momentum_6m,
       feat.volume_ratio, feat.max_dd_60d, feat.regime,
       feat.pivot_r2, feat.pivot_r1, feat.pivot_pp, feat.pivot_s1, feat.pivot_s2,
       feat.vwap_proxy, feat.momentum_5d, feat.momentum_10d,
       feat.gap_pct, feat.range_expansion, feat.vol_accel,
       feat.close_position, feat.upper_shadow_pct, feat.body_pct]
    );
    inserted++;
  }

  saveDb();
  return inserted;
}

/**
 * Compute features for a single bar using history up to that point.
 */
function computeSingleBar(slice, idx, allCandles) {
  const len = slice.length;
  if (len < 26) return null;

  const last = slice[len - 1];

  // ---- Moving Averages ----
  const sma20Val = sma(slice, 20);
  const sma50Val = len >= 50 ? sma(slice, 50) : null;
  const sma200Val = len >= 200 ? sma(slice, 200) : null;
  const ema12Val = ema(slice, 12);
  const ema26Val = ema(slice, 26);

  // ---- RSI ----
  const rsi14Val = rsi(slice, 14);
  const rsi7Val = len >= 8 ? rsi(slice, 7) : null;

  // ---- MACD ----
  const macdVal = ema12Val && ema26Val ? ema12Val - ema26Val : null;
  // Simple signal line approximation (9-period EMA of MACD)
  const macdSignal = macdVal != null ? computeMacdSignal(slice) : null;
  const macdHist = macdVal != null && macdSignal != null ? macdVal - macdSignal : null;

  // ---- Bollinger Bands ----
  const bb = computeBollinger(slice, 20);

  // ---- ATR (14) ----
  const atr14 = computeATR(slice, 14);

  // ---- OBV ----
  const obv = computeOBV(slice);

  // ---- Volatility ----
  const vol20d = volatility(slice, 20);

  // ---- Momentum ----
  const mom1m = len >= 21 ? (last.close - slice[len - 21].close) / slice[len - 21].close : null;
  const mom3m = len >= 63 ? (last.close - slice[len - 63].close) / slice[len - 63].close : null;
  const mom6m = len >= 126 ? (last.close - slice[len - 126].close) / slice[len - 126].close : null;

  // ---- Volume ratio ----
  const vol10 = slice.slice(-10).reduce((s, c) => s + c.volume, 0) / 10;
  const vol30 = slice.slice(-Math.min(30, len)).reduce((s, c) => s + c.volume, 0) / Math.min(30, len);
  const volumeRatio = vol30 > 0 ? vol10 / vol30 : 1;

  // ---- Max Drawdown 60d ----
  const dd60 = maxDrawdown(slice.slice(-60));

  // ---- Market Regime ----
  let regime = 'neutral';
  if (sma50Val && sma200Val) {
    if (sma50Val > sma200Val && rsi14Val > 50) regime = 'bullish';
    else if (sma50Val < sma200Val && rsi14Val < 50) regime = 'bearish';
    else if (vol20d && vol20d > 0.4) regime = 'volatile';
  }

  // ---- Pivot Points (Classic) ----
  // Use the previous bar's high/low/close to compute today's pivots
  const prevBar = len >= 2 ? slice[len - 2] : null;
  let pivotPP = null, pivotR1 = null, pivotR2 = null, pivotS1 = null, pivotS2 = null;
  if (prevBar) {
    pivotPP = (prevBar.high + prevBar.low + prevBar.close) / 3;
    pivotR1 = 2 * pivotPP - prevBar.low;
    pivotR2 = pivotPP + (prevBar.high - prevBar.low);
    pivotS1 = 2 * pivotPP - prevBar.high;
    pivotS2 = pivotPP - (prevBar.high - prevBar.low);
  }

  // ---- VWAP Proxy (volume-weighted average price over last 20 bars) ----
  const vwapSlice = slice.slice(-Math.min(20, len));
  const vwapTotalVol = vwapSlice.reduce((s, c) => s + c.volume, 0);
  const vwapProxy = vwapTotalVol > 0
    ? vwapSlice.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0) / vwapTotalVol
    : null;

  // ---- Short-term Momentum (5 and 10 days) ----
  const mom5d = len >= 6 ? (last.close - slice[len - 6].close) / slice[len - 6].close : null;
  const mom10d = len >= 11 ? (last.close - slice[len - 11].close) / slice[len - 11].close : null;

  // ---- T+1 Impulse Features ----
  // Gap: open vs previous close (reuses prevBar from Pivots above)
  const gapPct = prevBar ? (last.open - prevBar.close) / prevBar.close : null;

  // Range expansion: today's range vs 5D avg range
  const todayRange = last.high - last.low;
  let rangeExpansion = null;
  if (len >= 6) {
    const avgRange5 = slice.slice(-6, -1).reduce((s, c) => s + (c.high - c.low), 0) / 5;
    rangeExpansion = avgRange5 > 0 ? todayRange / avgRange5 : null;
  }

  // Volume acceleration: today's vol_ratio vs yesterday's vol_ratio
  let volAccel = null;
  if (len >= 31 && prevBar) {
    const prevVol10 = slice.slice(-11, -1).reduce((s, c) => s + c.volume, 0) / 10;
    const prevVol30 = slice.slice(-Math.min(31, len), -1).reduce((s, c) => s + c.volume, 0) / Math.min(30, len - 1);
    const prevVR = prevVol30 > 0 ? prevVol10 / prevVol30 : 1;
    volAccel = prevVR > 0 ? volumeRatio / prevVR : null;
  }

  // Close position within day's range (0=low, 1=high) — bullish if near high
  const closePos = todayRange > 0 ? (last.close - last.low) / todayRange : 0.5;

  // Upper shadow as % of range (small = buyers in control)
  const upperShadow = todayRange > 0 ? (last.high - Math.max(last.open, last.close)) / todayRange : 0;

  // Body as % of range (large = decisive move)
  const bodyPct = todayRange > 0 ? Math.abs(last.close - last.open) / todayRange : 0;

  return {
    sma20: r(sma20Val), sma50: r(sma50Val), sma200: r(sma200Val),
    ema12: r(ema12Val), ema26: r(ema26Val),
    rsi14: r(rsi14Val), rsi7: r(rsi7Val),
    macd: r(macdVal), macd_signal: r(macdSignal), macd_hist: r(macdHist),
    bb_upper: r(bb?.upper), bb_middle: r(bb?.middle), bb_lower: r(bb?.lower),
    atr14: r(atr14), obv: r(obv), vol_20d: r(vol20d),
    momentum_1m: r(mom1m), momentum_3m: r(mom3m), momentum_6m: r(mom6m),
    volume_ratio: r(volumeRatio), max_dd_60d: r(dd60), regime,
    pivot_r2: r(pivotR2), pivot_r1: r(pivotR1), pivot_pp: r(pivotPP),
    pivot_s1: r(pivotS1), pivot_s2: r(pivotS2),
    vwap_proxy: r(vwapProxy),
    momentum_5d: r(mom5d), momentum_10d: r(mom10d),
    gap_pct: r(gapPct), range_expansion: r(rangeExpansion), vol_accel: r(volAccel),
    close_position: r(closePos), upper_shadow_pct: r(upperShadow), body_pct: r(bodyPct),
  };
}

// ---- Helper: MACD signal (9-EMA of MACD line) ----
function computeMacdSignal(candles) {
  if (candles.length < 35) return null; // need 26 + 9
  const macdValues = [];
  for (let i = 25; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const e12 = ema(slice, 12);
    const e26 = ema(slice, 26);
    if (e12 != null && e26 != null) macdValues.push(e12 - e26);
  }
  if (macdValues.length < 9) return null;
  const k = 2 / 10;
  let signal = macdValues.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < macdValues.length; i++) {
    signal = macdValues[i] * k + signal * (1 - k);
  }
  return signal;
}

// ---- Bollinger Bands ----
function computeBollinger(candles, period = 20) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const mean = slice.reduce((s, c) => s + c.close, 0) / period;
  const variance = slice.reduce((s, c) => s + (c.close - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std };
}

// ---- ATR (Average True Range) ----
function computeATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }
  return atrSum / period;
}

// ---- On-Balance Volume ----
function computeOBV(candles) {
  let obv = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) obv += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume;
  }
  return obv;
}

/**
 * Compute features for ALL active instruments.
 * Also computes relative strength (stock vs WIG index) as a second pass.
 */
function computeAllFeatures(opts = {}) {
  const instruments = query("SELECT ticker FROM instruments WHERE active = 1");
  let total = 0;
  for (const inst of instruments) {
    const n = computeFeatures(inst.ticker, opts);
    if (n > 0) console.log(`[features] ${inst.ticker}: ${n} new features`);
    total += n;
  }

  // Second pass: compute relative_strength for latest bar of each ticker
  computeRelativeStrength();

  // Third pass: sector-relative strength
  computeSectorRelativeStrength();

  // Fourth pass: cross-sectional ranks for T+1 model
  computeCrossSectionalRanks();

  console.log(`[features] Total new features: ${total}`);
  return total;
}

/**
 * Relative Strength: stock's 20-day return vs WIG index's 20-day return.
 * RS > 0 = outperforming the market. Stored in features.relative_strength.
 */
function computeRelativeStrength() {
  const wigCandles = query(
    "SELECT date, close FROM candles WHERE ticker = 'WIG' AND (timeframe = '1d' OR timeframe IS NULL) ORDER BY date ASC"
  );
  if (wigCandles.length < 21) return;

  const wigLast = wigCandles[wigCandles.length - 1];
  const wig20Ago = wigCandles[wigCandles.length - 21];
  const wigReturn20d = (wigLast.close - wig20Ago.close) / wig20Ago.close;
  const wigDate = wigLast.date;

  const instruments = query("SELECT ticker FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','FUTURES')");
  for (const inst of instruments) {
    const candles = query(
      "SELECT date, close FROM candles WHERE ticker = ? AND (timeframe = '1d' OR timeframe IS NULL) ORDER BY date DESC LIMIT 21",
      [inst.ticker]
    );
    if (candles.length < 21) continue;

    const tickerReturn20d = (candles[0].close - candles[20].close) / candles[20].close;
    const rs = r(tickerReturn20d - wigReturn20d);

    // Update latest feature row
    run(
      'UPDATE features SET relative_strength = ? WHERE ticker = ? AND date = (SELECT MAX(date) FROM features WHERE ticker = ?)',
      [rs, inst.ticker, inst.ticker]
    );
  }
  saveDb();
}

/**
 * Sector Relative Strength: stock's 20-day return vs its sector peers' average.
 * sector_rs > 0 = outperforming sector average. Stored in features.sector_rs.
 */
function computeSectorRelativeStrength() {
  const instruments = query("SELECT ticker FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF')");

  // Pre-compute 20d returns for all tickers
  const returns20d = {};
  for (const inst of instruments) {
    const candles = query(
      "SELECT close FROM candles WHERE ticker = ? AND (timeframe = '1d' OR timeframe IS NULL) ORDER BY date DESC LIMIT 21",
      [inst.ticker]
    );
    if (candles.length >= 21) {
      returns20d[inst.ticker] = (candles[0].close - candles[20].close) / candles[20].close;
    }
  }

  // For each ticker, compare to sector average
  for (const inst of instruments) {
    if (returns20d[inst.ticker] == null) continue;

    const peers = getSectorPeers(inst.ticker);
    const peerReturns = peers
      .filter(p => p !== inst.ticker && returns20d[p] != null)
      .map(p => returns20d[p]);

    if (peerReturns.length === 0) continue;

    const sectorAvg = peerReturns.reduce((s, v) => s + v, 0) / peerReturns.length;
    const sectorRs = r(returns20d[inst.ticker] - sectorAvg);

    run(
      'UPDATE features SET sector_rs = ? WHERE ticker = ? AND date = (SELECT MAX(date) FROM features WHERE ticker = ?)',
      [sectorRs, inst.ticker, inst.ticker]
    );
  }
  saveDb();
}

/**
 * Cross-sectional ranks: percentile of 1D momentum, volume ratio, and
 * relative strength across all active tickers on the same (latest) date.
 * Stored as 0-1 rank (1 = best in universe).
 */
function computeCrossSectionalRanks() {
  const instruments = query("SELECT ticker FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','FUTURES')");

  // Gather latest feature row per ticker
  const rows = [];
  for (const inst of instruments) {
    const feat = queryOne(
      'SELECT ticker, momentum_5d, volume_ratio, relative_strength FROM features WHERE ticker = ? ORDER BY date DESC LIMIT 1',
      [inst.ticker]
    );
    if (feat) rows.push(feat);
  }

  if (rows.length < 2) return;

  // Rank helper: returns percentile 0-1 (1 = highest)
  function percentileRank(arr, key) {
    const sorted = [...arr].filter(a => a[key] != null).sort((a, b) => a[key] - b[key]);
    const n = sorted.length;
    for (let i = 0; i < n; i++) {
      sorted[i][key + '_rank'] = n > 1 ? i / (n - 1) : 0.5;
    }
  }

  percentileRank(rows, 'momentum_5d');
  percentileRank(rows, 'volume_ratio');
  percentileRank(rows, 'relative_strength');

  for (const row of rows) {
    run(
      `UPDATE features SET mom1d_rank = ?, vol_rank = ?, rs_rank = ?
       WHERE ticker = ? AND date = (SELECT MAX(date) FROM features WHERE ticker = ?)`,
      [
        r(row.momentum_5d_rank ?? null),
        r(row.volume_ratio_rank ?? null),
        r(row.relative_strength_rank ?? null),
        row.ticker, row.ticker,
      ]
    );
  }
  saveDb();
}

/**
 * Get latest features for a ticker.
 */
function getLatestFeatures(ticker) {
  return queryOne(
    'SELECT * FROM features WHERE ticker = ? ORDER BY date DESC LIMIT 1',
    [ticker]
  );
}

function r(v) { return v != null ? Math.round(v * 10000) / 10000 : null; }

module.exports = { computeFeatures, computeAllFeatures, getLatestFeatures };
