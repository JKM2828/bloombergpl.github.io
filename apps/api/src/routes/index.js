// ============================================================
// API Routes – Express router
// ============================================================
const express = require('express');
const { query, queryOne, run, saveDb } = require('../db/connection');
const { runScreener, getLatestRanking, getDailyPicks, saveDailyPicks, validatePastPicks, getPickPerformance, getPickStats, getFuturesPicks, getBestToInvest, getDailyGrowthReport, getWeeklyGrowthReport } = require('../screener/rankingService');
const { ingestAll, ingestIncremental, ingestIntraday, ingestIntraday5m, validateTicker } = require('../ingest/ingestPipeline');
const { getLiveStats } = require('../ws/liveCandles');
const portfolio = require('../portfolio/portfolioService');
const providerManager = require('../providers');
const { ALL_INSTRUMENTS, sma, ema, rsi, volatility, maxDrawdown } = require('../../../../packages/shared/src');
const { computeAllFeatures, getLatestFeatures } = require('../ml/featureEngineering');
const { predictAll, getLatestPredictions, getLatestPrediction, trainAll } = require('../ml/mlEngine');
const { backtestAll } = require('../ml/backtest');
const { generateAllSignals, getLatestSignals, assessPortfolioRisk, calculateStopLevels, computeSellLevels, getSellCandidates, RISK_CONFIG } = require('../ml/riskEngine');
const { enqueueJob, drainQueue, getWorkerStatus, getCurrentMode, getPrecisionKPI } = require('../worker/jobWorker');
const { getLastCycleStats } = require('../ingest/ingestPipeline');
const { assessFeedQuality, assessAllFeedQuality } = require('../ingest/feedMonitor');

const router = express.Router();

// ---- Anti-cache middleware for all dynamic API endpoints ----
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ============================================================
// Instruments
// ============================================================
router.get('/instruments', (req, res) => {
  const { type } = req.query;
  let sql = `SELECT i.*,
    (SELECT c.close FROM candles c WHERE c.ticker = i.ticker ORDER BY c.date DESC LIMIT 1) as lastClose,
    (SELECT c.date  FROM candles c WHERE c.ticker = i.ticker ORDER BY c.date DESC LIMIT 1) as lastDate
  FROM instruments i WHERE i.active = 1`;
  const params = [];
  if (type) {
    sql += ' AND i.type = ?';
    params.push(type.toUpperCase());
  }
  sql += ' ORDER BY i.type, i.ticker';
  res.json(query(sql, params));
});

router.get('/instruments/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const inst = queryOne('SELECT * FROM instruments WHERE ticker = ?', [ticker]);
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  // Add latest price + freshness
  const latest = queryOne(
    'SELECT close, date FROM candles WHERE ticker = ? ORDER BY date DESC LIMIT 1',
    [ticker]
  );
  const ingestRow = queryOne(
    "SELECT MAX(created_at) as ts FROM ingest_log WHERE ticker = ? AND status = 'ok'",
    [ticker]
  );
  res.json({
    ...inst,
    latestPrice: latest?.close || null,
    latestDate: latest?.date || null,
    lastIngest: ingestRow?.ts || null,
  });
});

// ============================================================
// Data freshness summary
// ============================================================
router.get('/freshness', (req, res) => {
  const tickers = query('SELECT ticker FROM instruments WHERE active = 1');
  const results = [];
  for (const { ticker } of tickers) {
    const latest = queryOne(
      'SELECT date, close FROM candles WHERE ticker = ? ORDER BY date DESC LIMIT 1',
      [ticker]
    );
    const bizDays = latest ? businessDaysSince(latest.date) : 999;
    results.push({
      ticker,
      lastDate: latest?.date || null,
      lastClose: latest?.close || null,
      businessDaysBehind: bizDays,
      stale: bizDays > 2,
    });
  }
  const staleCount = results.filter(r => r.stale).length;
  res.json({
    total: results.length,
    fresh: results.length - staleCount,
    stale: staleCount,
    tickers: results,
  });
});

/**
 * Count business days (Mon-Fri) since a given date string.
 * Weekends/holidays don't count as "stale" days.
 */
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
  const d = new Date(dateStr);
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

// ============================================================
// Candles / chart data
// ============================================================
router.get('/candles/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const { from, to, limit, timeframe } = req.query;
  const tf = (timeframe === '1h' || timeframe === '15m' || timeframe === '5m') ? timeframe : '1d';

  let sql = 'SELECT date, open, high, low, close, volume FROM candles WHERE ticker = ? AND (timeframe = ? OR timeframe IS NULL)';
  const params = [ticker, tf];

  // For daily, also include legacy rows without timeframe column
  if (tf === '1d') {
    sql = 'SELECT date, open, high, low, close, volume FROM candles WHERE ticker = ? AND (timeframe = ? OR timeframe IS NULL OR timeframe = \'1d\')';
  }
  // For 5m, only match exact timeframe
  if (tf === '5m') {
    sql = 'SELECT date, open, high, low, close, volume FROM candles WHERE ticker = ? AND timeframe = ?';
  }

  if (from) { sql += ' AND date >= ?'; params.push(from); }
  if (to) { sql += ' AND date <= ?'; params.push(to); }
  sql += ' ORDER BY date ASC';
  if (limit) { sql += ' LIMIT ?'; params.push(parseInt(limit)); }

  const candles = query(sql, params);
  if (candles.length === 0) return res.status(404).json({ error: 'No candle data' });

  // Compute indicators
  const sma20 = sma(candles, 20);
  const sma50 = sma(candles, 50);
  const sma200 = sma(candles, 200);
  const rsiVal = rsi(candles, 14);
  const vol = volatility(candles, 20);
  const dd = maxDrawdown(candles);

  // Freshness metadata
  const lastDate = candles[candles.length - 1]?.date || null;
  const ingestRow = queryOne(
    "SELECT MAX(created_at) as ts FROM ingest_log WHERE ticker = ? AND status = 'ok'",
    [ticker]
  );

  // Load latest features for enriched indicators
  const feat = queryOne(
    'SELECT pivot_r2, pivot_r1, pivot_pp, pivot_s1, pivot_s2, vwap_proxy, momentum_5d, momentum_10d, relative_strength, volume_ratio FROM features WHERE ticker = ? ORDER BY date DESC LIMIT 1',
    [ticker]
  );

  res.json({
    ticker,
    timeframe: tf,
    count: candles.length,
    lastDate,
    lastIngest: ingestRow?.ts || null,
    candles,
    indicators: {
      sma20: sma20 ? Math.round(sma20 * 100) / 100 : null,
      sma50: sma50 ? Math.round(sma50 * 100) / 100 : null,
      sma200: sma200 ? Math.round(sma200 * 100) / 100 : null,
      rsi14: rsiVal ? Math.round(rsiVal * 100) / 100 : null,
      volatility: vol ? Math.round(vol * 10000) / 100 : null,
      maxDrawdown: dd ? Math.round(dd * 10000) / 100 : null,
      pivot_r2: feat?.pivot_r2 != null ? Math.round(feat.pivot_r2 * 100) / 100 : null,
      pivot_r1: feat?.pivot_r1 != null ? Math.round(feat.pivot_r1 * 100) / 100 : null,
      pivot_pp: feat?.pivot_pp != null ? Math.round(feat.pivot_pp * 100) / 100 : null,
      pivot_s1: feat?.pivot_s1 != null ? Math.round(feat.pivot_s1 * 100) / 100 : null,
      pivot_s2: feat?.pivot_s2 != null ? Math.round(feat.pivot_s2 * 100) / 100 : null,
      vwap_proxy: feat?.vwap_proxy != null ? Math.round(feat.vwap_proxy * 100) / 100 : null,
      momentum_5d: feat?.momentum_5d != null ? Math.round(feat.momentum_5d * 10000) / 10000 : null,
      momentum_10d: feat?.momentum_10d != null ? Math.round(feat.momentum_10d * 10000) / 10000 : null,
      relative_strength: feat?.relative_strength != null ? Math.round(feat.relative_strength * 10000) / 10000 : null,
      volume_ratio: feat?.volume_ratio != null ? Math.round(feat.volume_ratio * 100) / 100 : null,
    },
  });
});

// ============================================================
// Ranking / Screener
// ============================================================
router.get('/ranking', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const ranking = getLatestRanking(limit);
  const rankedAt = ranking.length > 0 ? ranking[0].ranked_at : null;
  const dataAgeSec = rankedAt ? Math.round((Date.now() - new Date(rankedAt).getTime()) / 1000) : null;
  res.json({ count: ranking.length, rankedAt, dataAgeSec, ranking });
});

router.post('/ranking/run', async (req, res) => {
  try {
    const results = runScreener();
    // Auto-save top 5 as daily picks
    const picksData = getDailyPicks();
    if (picksData.picks.length > 0) saveDailyPicks(picksData.picks);
    res.json({ message: 'Ranking complete', count: results.length, top5: results.slice(0, 5) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Daily Picks – Top 5 aggressive swing candidates (1-3 days)
// ============================================================
router.get('/picks/daily', (req, res) => {
  const limit = parseInt(req.query.limit) || 5;
  const assetTypes = req.query.types ? req.query.types.split(',').map(t => t.trim().toUpperCase()) : undefined;
  const data = getDailyPicks({ assetTypes, limit });
  const generatedAt = data.generatedAt || null;
  const dataAgeSec = generatedAt ? Math.round((Date.now() - new Date(generatedAt).getTime()) / 1000) : null;
  res.json({
    ...data,
    dataAgeSec,
    disclaimer: 'Dzienne Top picks – analiza algorytmiczna, nie stanowi porady inwestycyjnej.',
  });
});

router.get('/picks/futures', (req, res) => {
  const limit = parseInt(req.query.limit) || 5;
  const data = getFuturesPicks(limit);
  res.json({
    ...data,
    disclaimer: 'Top kontrakty terminowe – analiza algorytmiczna, nie stanowi porady inwestycyjnej.',
  });
});

router.get('/picks/best', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const data = getBestToInvest(limit);
  res.json({
    ...data,
    disclaimer: 'Najlepsze okazje – analiza algorytmiczna, nie stanowi porady inwestycyjnej.',
  });
});

router.get('/picks/stats', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const stats = getPickStats(days);
  if (!stats) return res.json({ message: 'Brak zwalidowanych wyników', stats: null });
  res.json({ days, stats });
});

router.get('/picks/performance', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const performance = getPickPerformance(days);
  res.json({ count: performance.length, days, performance });
});

// ============================================================
// Sygnały Dnia – "Co kupić / co sprzedać dzisiaj"
// Unified BUY/SELL/HOLD view for all analyzed instruments
// ============================================================
router.get('/today', (req, res) => {
  const limit = parseInt(req.query.limit) || 30;

  // 1. Get all signals (ML-based BUY/SELL)
  const signals = getLatestSignals(100);

  // 2. Get daily picks (top BUY candidates)
  const picksData = getDailyPicks({ limit: 10 });

  // 3. Get sell candidates (portfolio positions to exit)
  const sellCandidates = getSellCandidates();

  // 4. Build unified action table
  const actions = [];
  const seen = new Set();

  // BUY picks first (highest confidence)
  for (const pick of picksData.picks) {
    seen.add(pick.ticker);
    actions.push({
      ticker: pick.ticker,
      name: pick.name,
      type: pick.type,
      sector: pick.sector,
      action: 'KUP',
      price: pick.metrics?.lastClose || null,
      confidence: pick.ml?.confidence || null,
      expectedReturn: pick.ml?.expectedReturn || null,
      compositeScore: pick.compositeScore,
      rsi: pick.metrics?.rsi14 || null,
      reason: pick.reasons || '',
    });
  }

  // SELL candidates (portfolio positions)
  for (const sell of sellCandidates) {
    seen.add(sell.ticker);
    const inst = queryOne('SELECT name, type FROM instruments WHERE ticker = ?', [sell.ticker]);
    actions.push({
      ticker: sell.ticker,
      name: inst?.name || sell.ticker,
      type: inst?.type || 'STOCK',
      sector: null,
      action: sell.action === 'SELL' ? 'SPRZEDAJ' : sell.action === 'PARTIAL_SELL' ? 'CZĘŚCIOWO SPRZEDAJ' : 'ROZWAŻ SPRZEDAŻ',
      price: sell.currentPrice,
      confidence: null,
      expectedReturn: sell.pnlPct,
      compositeScore: null,
      rsi: null,
      reason: sell.sellReasons.join('; '),
    });
  }

  // SELL signals from ML (not already in picks/sell candidates)
  for (const sig of signals) {
    if (seen.has(sig.ticker)) continue;
    const direction = sig.direction || (sig.details ? JSON.parse(sig.details).direction : null);
    if (!direction) continue;
    seen.add(sig.ticker);
    const details = sig.details ? JSON.parse(sig.details) : {};
    actions.push({
      ticker: sig.ticker,
      name: sig.name || sig.ticker,
      type: sig.type || 'STOCK',
      sector: null,
      action: direction === 'BUY' ? 'KUP' : direction === 'SELL' ? 'SPRZEDAJ' : 'TRZYMAJ',
      price: sig.lastClose || null,
      confidence: details.confidence || null,
      expectedReturn: details.expectedReturnPct || null,
      compositeScore: null,
      rsi: details.rsi14 || null,
      reason: sig.reason || details.reason || '',
    });
  }

  res.json({
    date: new Date().toISOString().slice(0, 10),
    regime: picksData.regime,
    count: actions.length,
    actions: actions.slice(0, limit),
    disclaimer: 'Sygnały dnia — analiza algorytmiczna, nie stanowi porady inwestycyjnej. Inwestowanie wiąże się z ryzykiem.',
  });
});

router.post('/picks/validate', (req, res) => {
  try {
    const validated = validatePastPicks();
    res.json({ message: `Zwalidowano ${validated} przeszłych wyborów`, validated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Ingest
// ============================================================
router.post('/ingest/full', async (req, res) => {
  try {
    const result = await ingestAll(365, false); // full = don't skip fresh
    res.json({ message: 'Full ingest complete', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingest/incremental', async (req, res) => {
  try {
    const result = await ingestIncremental();
    res.json({ message: 'Incremental ingest complete', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingest/intraday', async (req, res) => {
  try {
    const maxTickers = parseInt(req.query.maxTickers) || 22;
    const result = await ingestIntraday(maxTickers);
    res.json({ message: 'Intraday ingest complete', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingest/intraday5m', async (req, res) => {
  try {
    const maxTickers = parseInt(req.query.maxTickers) || 200;
    const result = await ingestIntraday5m(maxTickers);
    res.json({ message: '5m intraday ingest complete', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Portfolio
// ============================================================
router.get('/portfolio/balance', (req, res) => {
  res.json({ balance: portfolio.getBalance() });
});

router.get('/portfolio/positions', (req, res) => {
  res.json({ positions: portfolio.getPositions() });
});

router.get('/portfolio/transactions', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ transactions: portfolio.getTransactionHistory('default', limit) });
});

router.post('/portfolio/deposit', (req, res) => {
  try {
    const { amount } = req.body;
    const result = portfolio.deposit(parseFloat(amount));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/portfolio/withdraw', (req, res) => {
  try {
    const { amount } = req.body;
    const result = portfolio.withdraw(parseFloat(amount));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/portfolio/buy', (req, res) => {
  try {
    const { ticker, shares } = req.body;
    const result = portfolio.buy(ticker.toUpperCase(), parseFloat(shares));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/portfolio/sell', (req, res) => {
  try {
    const { ticker, shares } = req.body;
    const result = portfolio.sell(ticker.toUpperCase(), parseFloat(shares));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
// Health & data quality
// ============================================================
router.get('/health', async (req, res) => {
  const providers = await providerManager.healthCheckAll();
  const instrumentCount = (queryOne('SELECT count(*) as n FROM instruments WHERE active = 1') || {}).n || 0;
  const candleCount = (queryOne('SELECT count(*) as n FROM candles') || {}).n || 0;
  const lastIngest = (queryOne("SELECT MAX(created_at) as d FROM ingest_log WHERE status = 'ok'") || {}).d || null;

  const allOk = providers.every(p => p.ok);
  const anyOk = providers.some(p => p.ok);
  const anyRateLimited = providers.some(p => p.rateLimited);
  const allRateLimited = providers.every(p => p.rateLimited || !p.ok);
  // If at least one provider works → ok or degraded; all down/limited → rate_limited or down
  const status = allOk ? 'ok' : anyOk ? 'degraded' : anyRateLimited ? 'rate_limited' : 'down';

  res.json({
    status,
    instruments: instrumentCount,
    candles: candleCount,
    lastIngest,
    providers,
    live: getLiveStats(),
    precisionKPI: getPrecisionKPI(),
  });
});

router.get('/ingest/log', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = query('SELECT * FROM ingest_log ORDER BY created_at DESC LIMIT ?', [limit]);
  res.json({ logs });
});

// ============================================================
// ML Predictions
// ============================================================
router.get('/predictions', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const predictions = getLatestPredictions(limit);
  res.json({
    count: predictions.length,
    disclaimer: 'Prognozy generowane przez model ML. Nie stanowią porady inwestycyjnej.',
    predictions,
  });
});

router.get('/predictions/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const pred = getLatestPrediction(ticker);
  if (!pred) return res.status(404).json({ error: 'No prediction for this ticker' });
  res.json({
    disclaimer: 'Prognoza modelu ML – wyłącznie informacyjna.',
    prediction: pred,
  });
});

router.post('/predictions/run', async (req, res) => {
  try {
    const horizonDays = parseInt(req.body.horizonDays) || 5;
    const predictions = predictAll(horizonDays);
    const signals = generateAllSignals(predictions);
    res.json({
      message: 'Predictions & signals generated',
      predictionsCount: predictions.length,
      signalsCount: signals.length,
      topSignals: signals.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ML Signals (trading recommendations)
// ============================================================
router.get('/signals', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const signals = getLatestSignals(limit);
  res.json({
    count: signals.length,
    disclaimer: 'Sygnały informacyjne. Nie stanowią rekomendacji inwestycyjnej.',
    riskLimits: RISK_CONFIG,
    signals,
  });
});

// ============================================================
// ML Training
// ============================================================
router.post('/ml/train', async (req, res) => {
  try {
    const results = trainAll(req.body || {});
    res.json({ message: 'Training complete', models: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ml/features', (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const count = computeAllFeatures({ force });
    res.json({ message: 'Features computed', count, force });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ml/features/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const features = getLatestFeatures(ticker);
  if (!features) return res.status(404).json({ error: 'No features for this ticker' });
  res.json(features);
});

router.get('/ml/models', (req, res) => {
  const models = query(
    "SELECT * FROM model_registry WHERE status = 'active' ORDER BY created_at DESC LIMIT 50"
  );
  res.json({ count: models.length, models });
});

// ============================================================
// Backtest
// ============================================================
router.post('/ml/backtest', async (req, res) => {
  try {
    const results = backtestAll(req.body || {});
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ml/backtest', (req, res) => {
  const latest = query('SELECT * FROM backtest_results ORDER BY created_at DESC LIMIT 10');
  res.json({ count: latest.length, results: latest.map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null })) });
});

// ============================================================
// Risk & Portfolio Risk
// ============================================================
router.get('/risk/portfolio', (req, res) => {
  const risk = assessPortfolioRisk();
  res.json(risk);
});

router.get('/risk/stops/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const latest = queryOne(
    'SELECT close FROM candles WHERE ticker = ? ORDER BY date DESC LIMIT 1',
    [ticker]
  );
  if (!latest) return res.status(404).json({ error: 'No price data' });
  const stops = calculateStopLevels(ticker, latest.close);
  res.json(stops);
});

// ============================================================
// Worker / Job Queue
// ============================================================
router.get('/worker/status', (req, res) => {
  res.json(getWorkerStatus());
});

router.post('/worker/enqueue', (req, res) => {
  const { jobType, payload, priority } = req.body;
  if (!jobType) return res.status(400).json({ error: 'jobType required' });
  enqueueJob(jobType, payload || {}, priority || 5);
  res.json({ message: `Job '${jobType}' enqueued` });
});

router.post('/worker/drain', async (req, res) => {
  try {
    const processed = await drainQueue();
    res.json({ message: `Queue drained: ${processed} jobs processed` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full pipeline trigger
router.post('/pipeline/run', async (req, res) => {
  try {
    enqueueJob('full_pipeline', {}, 1);
    const processed = await drainQueue();
    res.json({ message: 'Full pipeline executed', jobsProcessed: processed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Audit Log
// ============================================================
router.get('/audit', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?', [limit]);
  res.json({ count: logs.length, logs });
});

// ============================================================
// 24/7 System Status — full metrics dashboard
// ============================================================
router.get('/status/24x7', (req, res) => {
  const worker = getWorkerStatus();
  const budgetStats = providerManager.getBudgetStats();
  const lastCycle = getLastCycleStats();
  const instrumentCount = (queryOne('SELECT count(*) as n FROM instruments WHERE active = 1') || {}).n || 0;
  const candleCount = (queryOne('SELECT count(*) as n FROM candles') || {}).n || 0;
  const todayLogs = (queryOne(
    "SELECT count(*) as n FROM ingest_log WHERE created_at >= date('now')"
  ) || {}).n || 0;
  const todayErrors = (queryOne(
    "SELECT count(*) as n FROM ingest_log WHERE status IN ('error','rate_limited') AND created_at >= date('now')"
  ) || {}).n || 0;

  res.json({
    mode: getCurrentMode(),
    uptime: worker.startedAt ? Math.round((Date.now() - new Date(worker.startedAt).getTime()) / 1000) : 0,
    worker: {
      isRunning: worker.isRunning,
      currentMode: worker.currentMode,
      lastIngest: worker.lastIngest,
      lastAnalysisCycle: worker.lastAnalysisCycle,
      lastTraining: worker.lastTraining,
      analysisRuns: worker.analysisRuns,
      jobsProcessed: worker.jobsProcessed,
      jobsFailed: worker.jobsFailed,
      queueSize: worker.queueSize,
      activeLocks: worker.activeLocks,
    },
    budget: budgetStats,
    lastIngestCycle: lastCycle,
    precisionKPI: getPrecisionKPI(),
    data: {
      activeInstruments: instrumentCount,
      totalCandles: candleCount,
      todayIngestLogs: todayLogs,
      todayErrors,
    },
    disclaimer: 'System non-stop — dane informacyjne, nie stanowią porady inwestycyjnej.',
  });
});

// ============================================================
// Growth Reports – daily & weekly
// ============================================================
router.get('/growth/daily', (req, res) => {
  const report = getDailyGrowthReport();
  res.json(report);
});

router.get('/growth/weekly', (req, res) => {
  const report = getWeeklyGrowthReport();
  res.json(report);
});

// ============================================================
// Diagnostics – freshness per ticker  + provider health summary
// ============================================================
router.get('/diagnostics/freshness', (req, res) => {
  const tickers = query('SELECT ticker FROM instruments WHERE active = 1');
  const results = [];
  for (const { ticker } of tickers) {
    const daily = queryOne(
      "SELECT date, close FROM candles WHERE ticker = ? AND (timeframe = '1d' OR timeframe IS NULL) ORDER BY date DESC LIMIT 1",
      [ticker]
    );
    const intra = queryOne(
      "SELECT date FROM candles WHERE ticker = ? AND timeframe IN ('5m','1h') ORDER BY date DESC LIMIT 1",
      [ticker]
    );
    const lastLog = queryOne(
      "SELECT status, message, created_at FROM ingest_log WHERE ticker = ? ORDER BY created_at DESC LIMIT 1",
      [ticker]
    );
    const dailyAgeSec = daily ? Math.round((Date.now() - new Date(daily.date).getTime()) / 1000) : null;
    const intraAgeSec = intra ? Math.round((Date.now() - new Date(intra.date).getTime()) / 1000) : null;
    results.push({
      ticker,
      dailyDate: daily?.date || null,
      dailyClose: daily?.close || null,
      dailyAgeSec,
      intraDate: intra?.date || null,
      intraAgeSec,
      lastIngest: lastLog?.created_at || null,
      lastIngestStatus: lastLog?.status || null,
      stale: dailyAgeSec != null ? dailyAgeSec > 86400 * 3 : true,
    });
  }
  const staleCount = results.filter(r => r.stale).length;
  const budgetStats = providerManager.getBudgetStats();
  res.json({
    total: results.length,
    fresh: results.length - staleCount,
    stale: staleCount,
    budget: budgetStats,
    tickers: results,
  });
});

// ============================================================
// Precision KPI – model quality monitoring
// Returns current precision@1D/3D with status and retrain flag.
// Used by dashboard and alerts.
// ============================================================
router.get('/kpi/precision', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const stats = getPickStats(days);
  const cached = getPrecisionKPI();

  if (!stats || stats.totalPicks < 5) {
    return res.json({
      status: 'no_data',
      message: `Niewystarczające dane (minimum 5 picks za ostatnie ${days} dni)`,
      totalPicks: stats?.totalPicks || 0,
      cached,
      thresholds: { warn: 55, retrain: 45 },
    });
  }

  const { precision1D, precision3D, totalPicks, avgReturn1D, avgReturn3D } = stats;
  const status = precision1D < 45 ? 'critical' : precision1D < 55 ? 'warn' : 'ok';

  res.json({
    status,
    precision1D,
    precision3D,
    totalPicks,
    avgReturn1D,
    avgReturn3D,
    days,
    cached,
    thresholds: { warn: 55, retrain: 45 },
    disclaimer: 'Wyniki historyczne nie gwarantują przyszłych wyników.',
  });
});

// ============================================================
// Sell Signals – candidates & individual sell levels
// ============================================================
router.get('/sell/candidates', (req, res) => {
  const candidates = getSellCandidates();
  res.json({
    count: candidates.length,
    candidates,
    disclaimer: 'Sygnały sprzedaży – analiza algorytmiczna, nie stanowi porady inwestycyjnej.',
  });
});

router.get('/sell/levels/:ticker', (req, res) => {
  const { ticker } = req.params;
  const entryPrice = parseFloat(req.query.entry);
  if (!entryPrice || entryPrice <= 0) {
    return res.status(400).json({ error: 'Podaj parametr ?entry=<cena_wejścia>' });
  }
  const levels = computeSellLevels(ticker.toUpperCase(), entryPrice);
  if (!levels) return res.status(404).json({ error: 'Brak danych dla tego instrumentu' });
  res.json({ ticker: ticker.toUpperCase(), ...levels });
});

// ============================================================
// Feed Quality Monitor
// ============================================================
router.get('/health/feed', (req, res) => {
  const report = assessAllFeedQuality();
  res.json(report);
});

router.get('/health/feed/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const tf = req.query.timeframe || '1d';
  const result = assessFeedQuality(ticker, tf);
  res.json({ ticker, timeframe: tf, ...result });
});

// ============================================================
// Comprehensive Metrics Dashboard
// Single endpoint aggregating all system health indicators
// ============================================================
router.get('/metrics', (req, res) => {
  const startMs = Date.now();

  // --- Data stats ---
  const instrumentCount = (queryOne('SELECT count(*) as n FROM instruments WHERE active = 1') || {}).n || 0;
  const candleCount = (queryOne('SELECT count(*) as n FROM candles') || {}).n || 0;
  const featureCount = (queryOne('SELECT count(*) as n FROM features') || {}).n || 0;
  const predictionCount = (queryOne('SELECT count(*) as n FROM predictions') || {}).n || 0;
  const signalCount = (queryOne('SELECT count(*) as n FROM signals') || {}).n || 0;
  const modelCount = (queryOne("SELECT count(*) as n FROM model_registry WHERE status = 'active'") || {}).n || 0;

  // --- Today's activity ---
  const todayIngestOk = (queryOne(
    "SELECT count(*) as n FROM ingest_log WHERE status = 'ok' AND created_at >= date('now')"
  ) || {}).n || 0;
  const todayIngestErr = (queryOne(
    "SELECT count(*) as n FROM ingest_log WHERE status IN ('error','rate_limited') AND created_at >= date('now')"
  ) || {}).n || 0;
  const todaySignals = (queryOne(
    "SELECT count(*) as n FROM signals WHERE created_at >= date('now')"
  ) || {}).n || 0;

  // --- Pick performance (last 30 days) ---
  const pickStats = getPickStats(30);

  // --- Latest ranking metadata ---
  const lastRankRow = queryOne('SELECT MAX(ranked_at) as d FROM rankings');
  const rankingAge = lastRankRow?.d ? Math.round((Date.now() - new Date(lastRankRow.d).getTime()) / 3600000) : null;

  // --- Model freshness ---
  const oldestModel = queryOne(
    "SELECT MIN(created_at) as d FROM model_registry WHERE status = 'active'"
  );
  const newestModel = queryOne(
    "SELECT MAX(created_at) as d FROM model_registry WHERE status = 'active'"
  );
  const modelAgeHours = newestModel?.d ? Math.round((Date.now() - new Date(newestModel.d).getTime()) / 3600000) : null;

  // --- Worker status ---
  const worker = getWorkerStatus();

  const elapsed = Date.now() - startMs;

  res.json({
    timestamp: new Date().toISOString(),
    computeMs: elapsed,
    data: {
      instruments: instrumentCount,
      candles: candleCount,
      features: featureCount,
      predictions: predictionCount,
      signals: signalCount,
      activeModels: modelCount,
    },
    today: {
      ingestOk: todayIngestOk,
      ingestErrors: todayIngestErr,
      signals: todaySignals,
      ingestSuccessRate: todayIngestOk + todayIngestErr > 0
        ? Math.round(todayIngestOk / (todayIngestOk + todayIngestErr) * 100) : null,
    },
    performance: pickStats ? {
      totalPicks: pickStats.totalPicks,
      precision1D: pickStats.precision1D,
      precision3D: pickStats.precision3D,
      avgReturn1D: pickStats.avgReturn1D,
      avgMAE: pickStats.avgMAE,
      avgMFE: pickStats.avgMFE,
    } : null,
    freshness: {
      rankingAgeHours: rankingAge,
      newestModelAgeHours: modelAgeHours,
      oldestModelDate: oldestModel?.d || null,
      newestModelDate: newestModel?.d || null,
    },
    worker: {
      isRunning: worker.isRunning,
      mode: worker.currentMode,
      queueSize: worker.queueSize,
      jobsProcessed: worker.jobsProcessed,
      jobsFailed: worker.jobsFailed,
    },
  });
});

// ============================================================
// Validation Report — structured quality assessment
// Aggregates pick precision, backtest results, model health,
// and data coverage into a single pass/fail report
// ============================================================
router.get('/report/validation', (req, res) => {
  const days = parseInt(req.query.days) || 30;

  // --- Pick performance ---
  const pickStats = getPickStats(days);
  const recentPicks = query(`
    SELECT ticker, pick_date, composite_score, return_1d, return_3d, mae, mfe
    FROM daily_picks WHERE validated = 1
    ORDER BY pick_date DESC LIMIT 20
  `);

  // --- Backtest results ---
  const latestBacktest = queryOne(
    'SELECT * FROM backtest_results ORDER BY created_at DESC LIMIT 1'
  );
  let backtestSummary = null;
  if (latestBacktest) {
    const details = latestBacktest.details ? JSON.parse(latestBacktest.details) : [];
    const passedTickers = details.filter(d => d.passed).map(d => d.ticker);
    const failedTickers = details.filter(d => !d.passed && d.trades > 0).map(d => d.ticker);
    backtestSummary = {
      runDate: latestBacktest.run_date || latestBacktest.created_at,
      totalTickers: latestBacktest.total_tickers,
      passedTickers: latestBacktest.passed_tickers,
      avgHitRate: latestBacktest.avg_hit_rate,
      avgProfitFactor: latestBacktest.avg_profit_factor,
      avgExpectancy: latestBacktest.avg_expectancy,
      passedList: passedTickers.slice(0, 15),
      failedList: failedTickers.slice(0, 10),
    };
  }

  // --- Model health ---
  const models = query(
    "SELECT model_name, accuracy, created_at FROM model_registry WHERE status = 'active' ORDER BY created_at DESC LIMIT 30"
  );
  const avgAccuracy = models.length > 0
    ? Math.round(models.reduce((s, m) => s + (m.accuracy || 0), 0) / models.length * 100) / 100
    : null;
  const staleModels = models.filter(m => {
    const age = (Date.now() - new Date(m.created_at).getTime()) / 86400000;
    return age > 14; // older than 2 weeks
  });

  // --- Data coverage ---
  const totalInstruments = (queryOne('SELECT count(*) as n FROM instruments WHERE active = 1') || {}).n || 0;
  const withFeatures = (queryOne(
    "SELECT count(DISTINCT ticker) as n FROM features WHERE date >= date('now', '-7 days')"
  ) || {}).n || 0;
  const withPredictions = (queryOne(
    "SELECT count(DISTINCT ticker) as n FROM predictions WHERE created_at >= date('now', '-3 days')"
  ) || {}).n || 0;

  // --- Overall health score (0-100) ---
  let healthScore = 0;
  let checks = 0;
  const issues = [];

  // Pick precision check
  if (pickStats && pickStats.totalPicks >= 5) {
    if (pickStats.precision1D >= 50) healthScore += 20;
    else issues.push(`Low 1D precision: ${pickStats.precision1D}% (target: 50%+)`);
    checks++;
    if (pickStats.avgReturn1D > 0) healthScore += 15;
    else issues.push(`Negative avg 1D return: ${pickStats.avgReturn1D}%`);
    checks++;
  } else {
    issues.push('Insufficient validated picks for assessment');
  }

  // Backtest check
  if (backtestSummary) {
    if (backtestSummary.avgProfitFactor >= 1.1) healthScore += 20;
    else issues.push(`Low profit factor: ${backtestSummary.avgProfitFactor} (target: 1.1+)`);
    checks++;
    if (backtestSummary.avgExpectancy > 0) healthScore += 10;
    else issues.push(`Negative expectancy: ${backtestSummary.avgExpectancy}`);
    checks++;
  }

  // Model health check
  if (models.length > 0) {
    if (avgAccuracy >= 0.55) healthScore += 15;
    else issues.push(`Low avg model accuracy: ${avgAccuracy} (target: 55%+)`);
    checks++;
    if (staleModels.length < models.length / 2) healthScore += 10;
    else issues.push(`${staleModels.length}/${models.length} models are stale (>14d)`);
    checks++;
  }

  // Data coverage check
  if (totalInstruments > 0) {
    const coverage = withFeatures / totalInstruments;
    if (coverage >= 0.8) healthScore += 10;
    else issues.push(`Low feature coverage: ${Math.round(coverage * 100)}% (target: 80%+)`);
    checks++;
  }

  const grade = healthScore >= 80 ? 'A' : healthScore >= 60 ? 'B' : healthScore >= 40 ? 'C' : healthScore >= 20 ? 'D' : 'F';

  res.json({
    generatedAt: new Date().toISOString(),
    period: `${days} days`,
    healthScore,
    grade,
    issues,
    pickPerformance: pickStats ? {
      ...pickStats,
      recentPicks: recentPicks.slice(0, 10),
    } : null,
    backtest: backtestSummary,
    models: {
      total: models.length,
      avgAccuracy,
      staleCount: staleModels.length,
    },
    dataCoverage: {
      totalInstruments,
      withRecentFeatures: withFeatures,
      withRecentPredictions: withPredictions,
      featureCoverage: totalInstruments > 0 ? Math.round(withFeatures / totalInstruments * 100) : 0,
    },
    disclaimer: 'Raport walidacyjny — wyniki historyczne nie gwarantują przyszłych wyników.',
  });
});

module.exports = router;
