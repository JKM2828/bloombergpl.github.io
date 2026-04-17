// ============================================================
// API Routes – Express router
// ============================================================
const express = require('express');
const { query, queryOne, run, saveDb, getDbHealth } = require('../db/connection');
const { runScreener, getLatestRanking, getDailyPicks, saveDailyPicks, validatePastPicks, getPickPerformance, getPickStats, getFuturesPicks, getBestToInvest, getDailyGrowthReport, getWeeklyGrowthReport } = require('../screener/rankingService');
const { ingestAll, ingestIncremental, ingestBackfillHistory, ingestIntraday, ingestIntraday5m, validateTicker, getLastCycleStats } = require('../ingest/ingestPipeline');
const { getLiveStats } = require('../ws/liveCandles');
const portfolio = require('../portfolio/portfolioService');
const providerManager = require('../providers');
const { ALL_INSTRUMENTS, sma, ema, rsi, volatility, maxDrawdown } = require('../../../../packages/shared/src');
const { computeAllFeatures, getLatestFeatures } = require('../ml/featureEngineering');
const { predictAll, getLatestPredictions, getLatestPrediction, trainAll } = require('../ml/mlEngine');
const { backtestAll } = require('../ml/backtest');
const { trainT1Model, predictTopGainersT1, validateT1Predictions, backtestT1, getT1KPI, getLatestTopGainersT1, loadT1Model } = require('../ml/topGainersT1');
const { generateAllSignals, getLatestSignals, assessPortfolioRisk, calculateStopLevels, computeSellLevels, getSellCandidates, getCompetitionSellCandidates, computeCompetitionAllocation, RISK_CONFIG, COMPETITION_DEFAULTS } = require('../ml/riskEngine');
const { enqueueJob, drainQueue, getWorkerStatus, getCurrentMode, getPrecisionKPI, getLatestPipelineRun, getPipelineRunById, checkAlerts } = require('../worker/jobWorker');
const { assessFeedQuality, assessAllFeedQuality } = require('../ingest/feedMonitor');
const requireAdmin = require('../middleware/requireAdmin');

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

router.post('/ranking/run', requireAdmin, async (req, res) => {
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
  const rankedAt = data.rankedAt || null;
  const dataAgeSec = rankedAt ? Math.round((Date.now() - new Date(rankedAt).getTime()) / 1000) : null;

  // Freshness gate: during market hours, flag data older than 10 min
  const FRESHNESS_GATE_SEC = 600;
  const isMarket = getCurrentMode() === 'market';
  const stale = isMarket && dataAgeSec != null && dataAgeSec > FRESHNESS_GATE_SEC;

  // Coverage from latest pipeline run — bind to same run_id as today endpoint
  const latestRun = getLatestPipelineRun();
  const coveragePct = latestRun?.coverage_pct ?? null;
  const coverageOk = coveragePct === null || coveragePct >= 95;
  const isCrisis = latestRun?.status === 'crisis';

  // X-Generated-At header for frontend freshness detection
  res.setHeader('X-Generated-At', rankedAt || new Date().toISOString());

  res.json({
    ...data,
    dataAgeSec,
    stale,
    coveragePct,
    coverageOk,
    crisis: isCrisis,
    pipelineRun: {
      runId: latestRun?.run_id || null,
      rankedAt,
      coveragePct,
      degraded: !!latestRun?.degraded,
      status: latestRun?.status || null,
    },
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

  // Unified run state metadata
  const latestRunForToday = getLatestPipelineRun();
  const isCrisisToday = latestRunForToday?.status === 'crisis';
  const picksRunMeta = {
    runId: latestRunForToday?.run_id || null,
    rankedAt: picksData.rankedAt || null,
    coveragePct: latestRunForToday?.coverage_pct ?? null,
    degraded: !!latestRunForToday?.degraded,
    status: latestRunForToday?.status || null,
  };

  res.setHeader('X-Generated-At', picksData.rankedAt || new Date().toISOString());

  res.json({
    date: new Date().toISOString().slice(0, 10),
    regime: picksData.regime,
    count: actions.length,
    actions: actions.slice(0, limit),
    crisis: isCrisisToday,
    pipelineRun: picksRunMeta,
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
// Top Gainers T+1 — "Które spółki jutro urosnąć najwięcej?"
// Dedicated T+1 ranking model, separate from daily picks.
// ============================================================
router.get('/top-gainers', (req, res) => {
  const limit = parseInt(req.query.limit) || 5;
  const data = getLatestTopGainersT1(limit);
  const kpi = getT1KPI(30);
  res.json({
    ...data,
    kpi,
    disclaimer: 'Top Gainers T+1 — prognoza algorytmiczna największych wzrostów na jutro. Nie stanowi porady inwestycyjnej.',
  });
});

router.post('/top-gainers/predict', (req, res) => {
  try {
    const topN = parseInt(req.query.top) || 5;
    const predictions = predictTopGainersT1(topN);
    res.json({
      message: `Wygenerowano ranking Top ${topN} na jutro`,
      count: predictions.length,
      predictions,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/top-gainers/train', requireAdmin, (req, res) => {
  try {
    const result = trainT1Model({ lookback: parseInt(req.query.lookback) || 300 });
    if (!result) return res.json({ message: 'Za mało danych do treningu T+1', result: null });
    res.json({ message: 'Model T+1 wytrenowany', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/top-gainers/backtest', requireAdmin, (req, res) => {
  try {
    const result = backtestT1({
      trainDays: parseInt(req.query.trainDays) || 120,
      step: parseInt(req.query.step) || 5,
    });
    res.json({ message: 'Backtest T+1 zakończony', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/top-gainers/validate', (req, res) => {
  try {
    const result = validateT1Predictions();
    res.json({ message: `Zwalidowano ${result.validated} prognoz T+1`, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/top-gainers/kpi', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const kpi = getT1KPI(days);
  if (!kpi) return res.json({ message: 'Brak danych KPI T+1', kpi: null });
  res.json({ days, kpi });
});

// ============================================================
// Ingest
// ============================================================
router.post('/ingest/full', requireAdmin, async (req, res) => {
  try {
    const result = await ingestAll(365, false); // full = don't skip fresh
    res.json({ message: 'Full ingest complete', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingest/incremental', requireAdmin, async (req, res) => {
  try {
    const result = await ingestIncremental();
    res.json({ message: 'Incremental ingest complete', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingest/intraday', requireAdmin, async (req, res) => {
  try {
    const maxTickers = parseInt(req.query.maxTickers) || 22;
    const result = await ingestIntraday(maxTickers);
    res.json({ message: 'Intraday ingest complete', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingest/intraday5m', requireAdmin, async (req, res) => {
  try {
    const maxTickers = parseInt(req.query.maxTickers) || 200;
    const result = await ingestIntraday5m(maxTickers);
    res.json({ message: '5m intraday ingest complete', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingest/backfill', requireAdmin, async (req, res) => {
  try {
    const lookbackDays = parseInt(req.query.lookbackDays || req.body?.lookbackDays) || 730;
    const maxTickers = parseInt(req.query.maxTickers || req.body?.maxTickers) || 80;
    const maxRequests = parseInt(req.query.maxRequests || req.body?.maxRequests) || 40;
    const result = await ingestBackfillHistory({ lookbackDays, maxTickers, maxRequests });
    res.json({
      message: 'History backfill complete',
      lookbackDays,
      maxTickers,
      maxRequests,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Portfolio
// ============================================================
router.get('/portfolio/balance', (req, res) => {
  const available = portfolio.getAvailableBalance();
  const pending = portfolio.getPendingCash();
  const total = portfolio.getTotalBalance();
  res.json({ balance: available, availableCash: available, pendingCash: pending, totalBalance: total });
});

router.get('/portfolio/positions', (req, res) => {
  res.json({ positions: portfolio.getPositions() });
});

router.get('/portfolio/transactions', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ transactions: portfolio.getTransactionHistory('default', limit) });
});

router.post('/portfolio/deposit', requireAdmin, (req, res) => {
  try {
    const { amount } = req.body;
    const result = portfolio.deposit(parseFloat(amount));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/portfolio/withdraw', requireAdmin, (req, res) => {
  try {
    const { amount } = req.body;
    const result = portfolio.withdraw(parseFloat(amount));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/portfolio/buy', requireAdmin, (req, res) => {
  try {
    const { ticker, shares } = req.body;
    const result = portfolio.buy(ticker.toUpperCase(), parseFloat(shares));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/portfolio/sell', requireAdmin, (req, res) => {
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

  // DB health
  const dbHealth = getDbHealth();

  // Queue depth
  const pendingJobs = (queryOne("SELECT COUNT(*) as cnt FROM jobs WHERE status = 'pending'") || {}).cnt || 0;
  const runningJobs = (queryOne("SELECT COUNT(*) as cnt FROM jobs WHERE status = 'running'") || {}).cnt || 0;

  // Optional-disabled providers (e.g. EODHD without API key) should not degrade overall status
  const isOptionalDisabled = (p) => p.provider === 'eodhd' && typeof p.error === 'string' && p.error.includes('No API key');
  const requiredProviders = providers.filter(p => !isOptionalDisabled(p));
  const allOk = requiredProviders.length === 0 || requiredProviders.every(p => p.ok);
  const anyOk = requiredProviders.some(p => p.ok);
  const anyRateLimited = requiredProviders.some(p => p.rateLimited);
  // If at least one required provider works → ok or degraded; all down/limited → rate_limited or down
  const providerStatus = allOk ? 'ok' : anyOk ? 'degraded' : anyRateLimited ? 'rate_limited' : 'down';

  // Data freshness: check how many tickers have recent data (< 3 days)
  const freshCount = (queryOne(
    "SELECT COUNT(DISTINCT ticker) as n FROM candles WHERE date >= date('now', '-3 days')"
  ) || {}).n || 0;
  const staleCount = instrumentCount - freshCount;
  const lowHistoryCount = (queryOne(`
    SELECT COUNT(*) AS n
    FROM (
      SELECT i.ticker, i.type, COALESCE(c.n, 0) AS candleCount
      FROM instruments i
      LEFT JOIN (
        SELECT ticker, COUNT(*) AS n
        FROM candles
        WHERE timeframe = '1d' OR timeframe IS NULL
        GROUP BY ticker
      ) c ON c.ticker = i.ticker
      WHERE i.active = 1 AND i.type IN ('STOCK','ETF','FUTURES','INDEX')
    ) t
    WHERE (t.type = 'FUTURES' AND t.candleCount < 40)
       OR (t.type IN ('STOCK','ETF','INDEX') AND t.candleCount < 60)
  `) || {}).n || 0;
  const avgDailyCandlesPerTicker = Number((queryOne(`
    SELECT AVG(cnt) AS n
    FROM (
      SELECT COUNT(*) AS cnt
      FROM candles
      WHERE timeframe = '1d' OR timeframe IS NULL
      GROUP BY ticker
    )
  `) || {}).n || 0);

  // Data staleness detection: if lastIngest is older than 24h, flag it
  const lastIngestAge = lastIngest ? Math.round((Date.now() - new Date(lastIngest).getTime()) / 1000) : null;
  const dataStale = lastIngestAge != null && lastIngestAge > 86400;

  // Last ingest cycle stats (from worker)
  const lastCycle = getLastCycleStats();

  // Overall status considers DB save failures, provider health, AND data staleness
  const dbOk = dbHealth.saveFailCount < 3;
  const worker = getWorkerStatus();
  const freshnessFull = staleCount <= 0;
  // If all data is fresh and system is operational, provider-level failures are not actionable
  const effectiveStatus = !dbOk ? 'degraded'
    : (dataStale && staleCount === instrumentCount) ? 'degraded'
    : (freshnessFull && worker.isRunning && dbOk) ? 'ok'
    : providerStatus;

  // Recovery blockers: list what is preventing the system from recovering
  // Suppress informational items when system is fully healthy
  const recoveryBlockers = [];
  const partialMissing = Math.max(0, lastCycle?.stillMissing ?? ((lastCycle?.tickers || 0) - (lastCycle?.batchHits || 0)));
  const partialMissingPct = (lastCycle?.tickers || 0) > 0 ? partialMissing / lastCycle.tickers : 0;
  const isSignificantBatchPartial = partialMissing > 1 || partialMissingPct > 0.01;
  if (lastCycle?.budgetExhausted) {
    recoveryBlockers.push('HTTP budget exhausted in last ingest cycle');
  }
  if (lastCycle?.batchPartial && !freshnessFull && isSignificantBatchPartial) {
    recoveryBlockers.push(`Batch partial: ${lastCycle.batchHits}/${lastCycle.tickers} tickers from Stooq JSON`);
  }
  if (!worker.isRunning) {
    recoveryBlockers.push('Worker scheduler is not running');
  }

  // Active alerts (from worker checkAlerts)
  const alerts = checkAlerts();

  res.json({
    status: effectiveStatus,
    uptime: process.uptime() | 0,
    instruments: instrumentCount,
    candles: candleCount,
    lastIngest,
    lastIngestAgeSec: lastIngestAge,
    freshness: { fresh: freshCount, stale: staleCount, total: instrumentCount },
    dataDepth: {
      lowHistoryTickers: lowHistoryCount,
      avgDailyCandlesPerTicker: Math.round(avgDailyCandlesPerTicker * 10) / 10,
    },
    dataStale,
    recoveryBlockers: recoveryBlockers.length > 0 ? recoveryBlockers : undefined,
    alerts: alerts.length > 0 ? alerts : undefined,
    db: dbHealth,
    queue: { pending: pendingJobs, running: runningJobs },
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
  // DATA-H1: freshness gate
  const newestPredAt = predictions.length ? predictions[0].created_at : null;
  const dataAgeSec = newestPredAt ? Math.round((Date.now() - new Date(newestPredAt).getTime()) / 1000) : null;
  const FRESHNESS_GATE_SEC = 86400; // 24h — predictions are batch-generated daily
  const isMarket = getCurrentMode() === 'market';
  const stale = isMarket && dataAgeSec != null && dataAgeSec > FRESHNESS_GATE_SEC;
  res.json({
    count: predictions.length,
    dataAgeSec,
    stale,
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

router.post('/predictions/run', requireAdmin, async (req, res) => {
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
  // DATA-H1: freshness gate
  const newestSigAt = signals.length ? signals[0].created_at : null;
  const dataAgeSec = newestSigAt ? Math.round((Date.now() - new Date(newestSigAt).getTime()) / 1000) : null;
  const FRESHNESS_GATE_SEC = 86400; // 24h
  const isMarket = getCurrentMode() === 'market';
  const stale = isMarket && dataAgeSec != null && dataAgeSec > FRESHNESS_GATE_SEC;
  res.json({
    count: signals.length,
    dataAgeSec,
    stale,
    disclaimer: 'Sygnały informacyjne. Nie stanowią rekomendacji inwestycyjnej.',
    riskLimits: RISK_CONFIG,
    signals,
  });
});

// ============================================================
// ML Training (synchronized: features → train → predict → signals → screener)
// ============================================================
router.post('/ml/train', requireAdmin, async (req, res) => {
  try {
    const sync = req.query.sync !== '0'; // default: full sync pipeline
    const steps = { features: 0, models: 0, predictions: 0, signals: 0, ranked: 0, skipped: [] };

    // Step 1: Recompute features from latest candles
    if (sync) {
      steps.features = computeAllFeatures({ force: false });
      console.log(`[ml/train] Features computed: ${steps.features}`);
    }

    // Step 2: Train all models
    const results = await trainAll(req.body || {});
    steps.models = results.length;

    // Collect tickers that were skipped (insufficient data)
    const allInstruments = query("SELECT ticker, type FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','INDEX','FUTURES')");
    const trainedTickers = new Set(results.map(r => r.ticker));
    steps.skipped = allInstruments
      .filter(i => !trainedTickers.has(i.ticker))
      .map(i => {
        const candleCount = (queryOne('SELECT COUNT(*) as n FROM candles WHERE ticker = ?', [i.ticker]) || {}).n || 0;
        const featureCount = (queryOne('SELECT COUNT(*) as n FROM features WHERE ticker = ?', [i.ticker]) || {}).n || 0;
        return { ticker: i.ticker, type: i.type, candles: candleCount, features: featureCount, reason: featureCount < 20 ? 'za mało features' : 'za mało próbek treningowych' };
      });

    // Step 3: Generate fresh predictions & signals from newly trained models
    if (sync) {
      const predictions = predictAll(req.body?.horizonDays || 5);
      steps.predictions = predictions.length;
      const signals = generateAllSignals(predictions);
      steps.signals = signals.length;
      console.log(`[ml/train] Predictions: ${predictions.length}, Signals: ${signals.length}`);

      // Step 4: Refresh screener/ranking with new predictions
      const rankings = runScreener();
      steps.ranked = rankings.length;
      const picksData = getDailyPicks();
      if (picksData.picks.length > 0) saveDailyPicks(picksData.picks);
      console.log(`[ml/train] Ranking: ${rankings.length}, Picks: ${picksData.picks.length}`);
    }

    res.json({
      message: sync
        ? `Pipeline zsynchronizowany: ${steps.models} modeli → ${steps.predictions} predykcji → ${steps.ranked} w rankingu`
        : `Wytrenowano ${steps.models} modeli (bez synchronizacji)`,
      models: steps.models,
      predictions: steps.predictions,
      signals: steps.signals,
      ranked: steps.ranked,
      featuresComputed: steps.features,
      skippedTickers: steps.skipped,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ml/features', requireAdmin, (req, res) => {
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
// ML Status — diagnostic endpoint for data coverage per ticker
// ============================================================
router.get('/ml/status', (req, res) => {
  const instruments = query("SELECT ticker, type, name FROM instruments WHERE active = 1 ORDER BY type, ticker");
  const tickers = instruments.map(i => {
    const candleRow = queryOne('SELECT COUNT(*) as n, MAX(date) as lastDate FROM candles WHERE ticker = ?', [i.ticker]);
    const featureRow = queryOne('SELECT COUNT(*) as n, MAX(date) as lastDate FROM features WHERE ticker = ?', [i.ticker]);
    const modelRow = queryOne("SELECT version, accuracy, training_samples, created_at FROM model_registry WHERE model_name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1", [i.ticker]);
    const predRow = queryOne('SELECT predicted_direction, confidence, created_at FROM predictions WHERE ticker = ? ORDER BY created_at DESC LIMIT 1', [i.ticker]);

    const candles = candleRow?.n || 0;
    const features = featureRow?.n || 0;
    const minSamples = (i.type === 'FUTURES' || i.type === 'INDEX') ? 8 : 20;
    const trainable = features >= minSamples;

    return {
      ticker: i.ticker,
      type: i.type,
      name: i.name,
      candles,
      candlesLastDate: candleRow?.lastDate || null,
      features,
      featuresLastDate: featureRow?.lastDate || null,
      trainable,
      minSamples,
      model: modelRow ? {
        version: modelRow.version,
        accuracy: modelRow.accuracy,
        samples: modelRow.training_samples,
        trainedAt: modelRow.created_at,
      } : null,
      prediction: predRow ? {
        direction: predRow.predicted_direction,
        confidence: predRow.confidence,
        createdAt: predRow.created_at,
      } : null,
    };
  });

  const summary = {
    total: tickers.length,
    withCandles: tickers.filter(t => t.candles > 0).length,
    withFeatures: tickers.filter(t => t.features > 0).length,
    trainable: tickers.filter(t => t.trainable).length,
    withModel: tickers.filter(t => t.model).length,
    withPrediction: tickers.filter(t => t.prediction).length,
    notTrainable: tickers.filter(t => !t.trainable).map(t => ({ ticker: t.ticker, candles: t.candles, features: t.features, minSamples: t.minSamples })),
  };

  res.json({ summary, tickers });
});

// ============================================================
// Backtest
// ============================================================
router.post('/ml/backtest', requireAdmin, async (req, res) => {
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

router.post('/worker/enqueue', requireAdmin, (req, res) => {
  const { jobType, payload, priority } = req.body;
  if (!jobType) return res.status(400).json({ error: 'jobType required' });
  enqueueJob(jobType, payload || {}, priority || 5);
  res.json({ message: `Job '${jobType}' enqueued` });
});

router.post('/worker/drain', requireAdmin, async (req, res) => {
  try {
    const processed = await drainQueue();
    res.json({ message: `Queue drained: ${processed} jobs processed` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full pipeline trigger (async — returns 202 immediately)
router.post('/pipeline/run', requireAdmin, async (req, res) => {
  try {
    enqueueJob('full_pipeline', {}, 1);
    // Fire-and-forget: drain in background, don't block the HTTP response
    drainQueue().catch(err => console.error('[pipeline/run] Background drain error:', err.message));
    res.status(202).json({
      message: 'Pipeline queued — use GET /api/pipeline/latest to track progress',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recovery trigger (async) — prioritize rebuilding history + analysis coverage
router.post('/pipeline/recover', requireAdmin, async (req, res) => {
  try {
    const lookbackDays = parseInt(req.query.lookbackDays || req.body?.lookbackDays) || 730;
    const maxTickers = parseInt(req.query.maxTickers || req.body?.maxTickers) || 120;
    const maxRequests = parseInt(req.query.maxRequests || req.body?.maxRequests) || 60;
    const enqueueTrain = String(req.query.enqueueTrain || req.body?.enqueueTrain || '1') !== '0';

    enqueueJob('backfill_history', { lookbackDays, maxTickers, maxRequests }, 1);
    enqueueJob('ingest', { mode: 'incremental' }, 2);
    if (enqueueTrain) enqueueJob('train', { reason: 'recovery' }, 3);
    enqueueJob('analysis', {}, 4);

    drainQueue().catch(err => console.error('[pipeline/recover] Background drain error:', err.message));
    res.status(202).json({
      message: 'Recovery pipeline queued — backfill + ingest + analysis',
      queued: {
        backfill_history: { lookbackDays, maxTickers, maxRequests },
        ingest: { mode: 'incremental' },
        train: enqueueTrain,
        analysis: true,
      },
      monitor: {
        worker: '/api/worker/status',
        pipeline: '/api/pipeline/latest',
        health: '/api/health',
      },
    });
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
  const lastCycle = getLastCycleStats();
  const worker = getWorkerStatus();
  res.json({
    total: results.length,
    fresh: results.length - staleCount,
    stale: staleCount,
    budget: budgetStats,
    lastIngestCycle: lastCycle ? {
      timestamp: lastCycle.timestamp,
      batchCoveragePct: lastCycle.batchCoveragePct,
      liveCoveragePct: lastCycle.liveCoveragePct,
      batchHits: lastCycle.batchHits,
      fallbackHits: lastCycle.fallbackHits,
      httpCalls: lastCycle.httpCalls,
      budgetExhausted: lastCycle.budgetExhausted,
      batchPartial: lastCycle.batchPartial,
      stillMissing: lastCycle.stillMissing,
    } : null,
    workerRunning: worker.isRunning,
    workerMode: worker.currentMode,
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
  const latestRunForSell = getLatestPipelineRun();
  res.setHeader('X-Generated-At', latestRunForSell?.started_at || new Date().toISOString());
  res.json({
    count: candidates.length,
    candidates,
    crisis: latestRunForSell?.status === 'crisis',
    pipelineRun: {
      runId: latestRunForSell?.run_id || null,
      rankedAt: latestRunForSell?.started_at || null,
      coveragePct: latestRunForSell?.coverage_pct ?? null,
      status: latestRunForSell?.status || null,
    },
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

// ============================================================
// Pipeline Run Status – per-run audit with ticker-level detail
// ============================================================
router.get('/pipeline/status', (req, res) => {
  const latest = getLatestPipelineRun();
  if (!latest) return res.json({ message: 'No pipeline runs recorded yet', run: null });
  const detail = getPipelineRunById(latest.run_id);
  res.json({ run: detail });
});

router.get('/pipeline/status/:runId', (req, res) => {
  const detail = getPipelineRunById(req.params.runId);
  if (!detail) return res.status(404).json({ error: 'Run not found' });
  res.json({ run: detail });
});

router.get('/pipeline/runs', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const runs = query(
    'SELECT run_id, started_at, finished_at, status, universe_total, ranked_ok, coverage_pct, degraded FROM pipeline_runs ORDER BY started_at DESC LIMIT ?',
    [limit]
  );
  res.json({ count: runs.length, runs });
});

// ============================================================
// Competition Decision Payload — aggregated daily pick for contest
// Returns Top 5 + best #1, allocation for fixed budget, guardrails,
// data freshness, precision KPI, alerts, and readiness status.
// ============================================================
router.get('/competition/decision', (req, res) => {
  const budget = parseFloat(req.query.budget) || COMPETITION_DEFAULTS.budget;

  // 1. Get daily picks (top 5, all asset types)
  const picksData = getDailyPicks({ assetTypes: ['STOCK', 'ETF', 'FUTURES'], limit: 5 });
  const picks = picksData.picks || [];

  // 2. Pipeline run & freshness
  const latestRun = getLatestPipelineRun();
  const rankedAt = picksData.rankedAt || null;
  const dataAgeSec = rankedAt ? Math.round((Date.now() - new Date(rankedAt).getTime()) / 1000) : null;
  const isCrisis = latestRun?.status === 'crisis';
  const isDegraded = !!latestRun?.degraded;
  const coveragePct = latestRun?.coverage_pct ?? null;

  // 3. Precision KPI
  const precisionKPI = getPrecisionKPI();

  // 4. Alerts
  const alerts = checkAlerts();
  const hasCriticalAlert = alerts.some(a => a.level === 'critical');

  // 5. Compute allocation for best pick (#1)
  const bestPick = picks.length > 0 ? picks[0] : null;
  const allocation = bestPick ? computeCompetitionAllocation(bestPick, { budget }) : null;

  // 6. Guardrails — determine overall readiness
  const guardReasons = [];
  if (isCrisis) guardReasons.push('blocked_by_crisis');
  if (hasCriticalAlert) guardReasons.push('blocked_by_critical_alert');
  if (precisionKPI && precisionKPI.status === 'critical') guardReasons.push('blocked_by_precision');
  if (coveragePct !== null && coveragePct < 5) guardReasons.push('blocked_by_low_coverage');
  if (!bestPick) guardReasons.push('no_picks_available');
  if (allocation && allocation.blocked) guardReasons.push(...allocation.blockReasons);

  // Freshness gate — block if ranking too old during market hours
  const isMarketComp = getCurrentMode() === 'market';
  if (isMarketComp && dataAgeSec != null && dataAgeSec > COMPETITION_DEFAULTS.freshnessGateSec) {
    guardReasons.push(`stale_ranking_${dataAgeSec}s`);
  }

  // Max open positions gate
  const openPositions = query(
    "SELECT ticker, shares, entry_price, entry_date FROM competition_portfolio WHERE status = 'open'"
  );
  if (openPositions.length >= (COMPETITION_DEFAULTS.maxOpenPositions || 3)) {
    guardReasons.push(`max_open_positions_${openPositions.length}`);
  }

  const ready = guardReasons.length === 0 && bestPick && allocation && !allocation.blocked;
  const alreadyHolding = bestPick ? openPositions.some(p => p.ticker === bestPick.ticker) : false;

  // 8. Enrich top 5 with individual allocations
  const top5 = picks.map((p, i) => {
    const alloc = computeCompetitionAllocation(p, { budget });
    return {
      rank: i + 1,
      ticker: p.ticker,
      name: p.name,
      type: p.type,
      sector: p.sector,
      compositeScore: p.compositeScore,
      edgeScore: p.edgeScore,
      ml: p.ml,
      sell: p.sell,
      growth: p.growth,
      relativeStrength: p.relativeStrength,
      allocation: alloc,
    };
  });

  res.json({
    ready,
    guardReasons,
    budget,
    bestPick: bestPick ? {
      ticker: bestPick.ticker,
      name: bestPick.name,
      type: bestPick.type,
      sector: bestPick.sector,
      compositeScore: bestPick.compositeScore,
      edgeScore: bestPick.edgeScore,
      ml: bestPick.ml,
      sell: bestPick.sell,
      growth: bestPick.growth,
      relativeStrength: bestPick.relativeStrength,
      allocation,
      alreadyHolding,
    } : null,
    top5,
    regime: picksData.regime,
    freshness: {
      rankedAt,
      dataAgeSec,
      stale: dataAgeSec != null && dataAgeSec > 600,
    },
    quality: {
      coveragePct,
      degraded: isDegraded,
      crisis: isCrisis,
      precisionKPI,
      alertCount: alerts.length,
      criticalAlerts: alerts.filter(a => a.level === 'critical'),
      warnings: alerts.filter(a => a.level === 'warning'),
    },
    pipelineRun: {
      runId: latestRun?.run_id || null,
      status: latestRun?.status || null,
      coveragePct,
      degraded: isDegraded,
    },
    disclaimer: 'Decyzja konkursowa — analiza algorytmiczna, nie stanowi porady inwestycyjnej.',
  });
});

// ============================================================
// Competition Auto-Buy — one-click guardrail-validated purchase
// ============================================================
router.post('/competition/auto-buy', requireAdmin, (req, res) => {
  const budget = parseFloat(req.body.budget) || COMPETITION_DEFAULTS.budget;
  const overrideTicker = req.body.ticker;  // optional: force a specific pick
  const overrideDuplicate = req.body.overrideDuplicate === true;

  // 1. Get daily picks
  const picksData = getDailyPicks({ assetTypes: ['STOCK', 'ETF', 'FUTURES'], limit: 5 });
  const picks = picksData.picks || [];

  // 2. Select target pick
  let targetPick;
  if (overrideTicker) {
    targetPick = picks.find(p => p.ticker === overrideTicker.toUpperCase());
    if (!targetPick) {
      return res.status(400).json({ success: false, reason: 'override_ticker_not_in_top5', ticker: overrideTicker });
    }
  } else {
    targetPick = picks.length > 0 ? picks[0] : null;
  }

  if (!targetPick) {
    return res.status(400).json({ success: false, reason: 'no_picks_available' });
  }

  // 3. Guardrails
  const latestRun = getLatestPipelineRun();
  const isCrisis = latestRun?.status === 'crisis';
  const precisionKPI = getPrecisionKPI();
  const alerts = checkAlerts();
  const hasCriticalAlert = alerts.some(a => a.level === 'critical');
  const coveragePct = latestRun?.coverage_pct ?? null;

  const guardReasons = [];
  if (isCrisis) guardReasons.push('blocked_by_crisis');
  if (hasCriticalAlert) guardReasons.push('blocked_by_critical_alert');
  if (precisionKPI && precisionKPI.status === 'critical') guardReasons.push('blocked_by_precision');
  if (coveragePct !== null && coveragePct < 5) guardReasons.push('blocked_by_low_coverage');

  // Freshness gate — refuse auto-buy on stale ranking during market hours
  const rankedAtBuy = picksData.rankedAt || null;
  const dataAgeSecBuy = rankedAtBuy ? Math.round((Date.now() - new Date(rankedAtBuy).getTime()) / 1000) : null;
  const isMarketBuy = getCurrentMode() === 'market';
  if (isMarketBuy && dataAgeSecBuy != null && dataAgeSecBuy > COMPETITION_DEFAULTS.freshnessGateSec) {
    guardReasons.push(`stale_ranking_${dataAgeSecBuy}s`);
  }

  // Max open positions gate
  const openPosBuy = query(
    "SELECT id FROM competition_portfolio WHERE status = 'open'"
  );
  if (openPosBuy.length >= (COMPETITION_DEFAULTS.maxOpenPositions || 3)) {
    guardReasons.push(`max_open_positions_${openPosBuy.length}`);
  }

  if (guardReasons.length > 0) {
    return res.status(422).json({ success: false, reason: 'guardrails_blocked', guardReasons });
  }

  // 4. Allocation
  const allocation = computeCompetitionAllocation(targetPick, { budget });
  if (allocation.blocked) {
    return res.status(422).json({ success: false, reason: 'allocation_blocked', blockReasons: allocation.blockReasons });
  }

  // 5. Idempotency: check duplicate open position for same ticker today
  const today = new Date().toISOString().slice(0, 10);
  const existingOpen = queryOne(
    "SELECT id FROM competition_portfolio WHERE ticker = ? AND status = 'open' AND entry_date = ?",
    [targetPick.ticker, today]
  );
  if (existingOpen && !overrideDuplicate) {
    return res.status(409).json({ success: false, reason: 'duplicate_position_today', ticker: targetPick.ticker, positionId: existingOpen.id });
  }

  // 6. Execute — save to competition_portfolio
  const entryPrice = allocation.price;
  const shares = allocation.shares;

  run(
    `INSERT INTO competition_portfolio (ticker, shares, entry_price, entry_date, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [targetPick.ticker, shares, entryPrice, today,
     `Auto-buy: score=${targetPick.compositeScore}, edge=${targetPick.edgeScore}, confidence=${targetPick.ml?.confidence}%, budget=${budget}`]
  );
  saveDb();

  // Audit log
  run(`INSERT INTO audit_log (event_type, entity, entity_id, payload)
       VALUES ('COMPETITION_AUTO_BUY', 'competition_portfolio', ?, ?)`,
    [targetPick.ticker, JSON.stringify({
      ticker: targetPick.ticker, shares, entryPrice, budget,
      compositeScore: targetPick.compositeScore,
      edgeScore: targetPick.edgeScore,
      confidence: targetPick.ml?.confidence,
    })]
  );
  saveDb();

  res.json({
    success: true,
    ticker: targetPick.ticker,
    name: targetPick.name,
    type: targetPick.type,
    shares,
    entryPrice,
    investedAmount: allocation.investedAmount,
    allocPct: allocation.allocPct,
    budget,
    sell: targetPick.sell,
    ml: targetPick.ml,
    message: `Kupiono ${shares}x ${targetPick.ticker} @ ${entryPrice} PLN (${allocation.investedAmount} PLN z ${budget} PLN budżetu)`,
  });
});

// ============================================================
// Competition Readiness — quick pass/fail score for "czy gram?"
// ============================================================
router.get('/competition/readiness', (req, res) => {
  const latestRun = getLatestPipelineRun();
  const precisionKPI = getPrecisionKPI();
  const alerts = checkAlerts();
  const picksData = getDailyPicks({ limit: 5 });
  const picks = picksData.picks || [];
  const rankedAt = picksData.rankedAt;
  const dataAgeSec = rankedAt ? Math.round((Date.now() - new Date(rankedAt).getTime()) / 1000) : null;

  const checks = [];

  // Pipeline ran recently
  const pipelineOk = latestRun && latestRun.status === 'completed';
  checks.push({ name: 'pipeline', ok: pipelineOk, detail: latestRun?.status || 'no_runs' });

  // Not crisis
  const noCrisis = latestRun?.status !== 'crisis';
  checks.push({ name: 'no_crisis', ok: noCrisis, detail: latestRun?.status || 'ok' });

  // Coverage >= 5% (realistic threshold given limited historical data for GPW universe)
  const coverageOk = latestRun?.coverage_pct == null || latestRun.coverage_pct >= 5;
  checks.push({ name: 'coverage', ok: coverageOk, detail: `${latestRun?.coverage_pct ?? '?'}%` });

  // Not degraded
  const notDegraded = !latestRun?.degraded;
  checks.push({ name: 'not_degraded', ok: notDegraded, detail: latestRun?.degraded ? 'degraded' : 'ok' });

  // Precision not critical
  const precisionOk = !precisionKPI || precisionKPI.status !== 'critical';
  checks.push({ name: 'precision', ok: precisionOk, detail: precisionKPI ? `${precisionKPI.precision1D}% (${precisionKPI.status})` : 'no_data' });

  // No critical alerts
  const noCritical = !alerts.some(a => a.level === 'critical');
  checks.push({ name: 'no_critical_alerts', ok: noCritical, detail: `${alerts.length} alerts` });

  // Data freshness < 30 min
  const freshOk = dataAgeSec != null && dataAgeSec < 1800;
  checks.push({ name: 'data_fresh', ok: freshOk, detail: dataAgeSec != null ? `${Math.round(dataAgeSec / 60)} min` : 'no_data' });

  // Picks available
  const hasPicks = picks.length > 0;
  checks.push({ name: 'has_picks', ok: hasPicks, detail: `${picks.length} picks` });

  const passed = checks.filter(c => c.ok).length;
  const total = checks.length;
  const score = Math.round((passed / total) * 100);
  const ready = checks.every(c => c.ok);

  res.json({
    ready,
    score,
    passed,
    total,
    checks,
    recommendation: ready ? 'GO — wszystkie warunki spełnione' :
      score >= 75 ? 'CAUTION — większość warunków OK, sprawdź niespełnione' :
      score >= 50 ? 'RISKY — połowa warunków niespełniona' :
      'NO GO — zbyt wiele problemów',
  });
});

// ============================================================
// Competition Portfolio – track real competition positions
// ============================================================
router.get('/competition/portfolio', (req, res) => {
  const positions = query(
    "SELECT * FROM competition_portfolio WHERE status = 'open' ORDER BY entry_date DESC"
  );
  // Enrich with current price + P&L
  const enriched = positions.map(pos => {
    const latest = queryOne(
      'SELECT close, date FROM candles WHERE ticker = ? ORDER BY date DESC LIMIT 1',
      [pos.ticker]
    );
    const currentPrice = latest?.close || pos.entry_price;
    const pnlPct = ((currentPrice - pos.entry_price) / pos.entry_price * 100);
    const pnlValue = (currentPrice - pos.entry_price) * pos.shares;
    return {
      ...pos,
      currentPrice: Math.round(currentPrice * 100) / 100,
      currentDate: latest?.date || null,
      pnlPct: Math.round(pnlPct * 100) / 100,
      pnlValue: Math.round(pnlValue * 100) / 100,
      marketValue: Math.round(currentPrice * pos.shares * 100) / 100,
    };
  });

  const totalValue = enriched.reduce((s, p) => s + p.marketValue, 0);
  const totalPnl = enriched.reduce((s, p) => s + p.pnlValue, 0);

  res.json({
    count: enriched.length,
    totalMarketValue: Math.round(totalValue * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100,
    positions: enriched,
  });
});

router.post('/competition/buy', requireAdmin, (req, res) => {
  const { ticker, shares, entry_price, entry_date, notes } = req.body;
  if (!ticker || !shares || !entry_price) {
    return res.status(400).json({ error: 'ticker, shares, entry_price required' });
  }
  run(
    `INSERT INTO competition_portfolio (ticker, shares, entry_price, entry_date, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [ticker.toUpperCase(), parseFloat(shares), parseFloat(entry_price),
     entry_date || new Date().toISOString().slice(0, 10), notes || null]
  );
  saveDb();
  res.json({ message: `Bought ${shares} ${ticker.toUpperCase()} @ ${entry_price}` });
});

router.post('/competition/sell', requireAdmin, (req, res) => {
  const { positionId, exit_price, exit_date } = req.body;
  if (!positionId || !exit_price) {
    return res.status(400).json({ error: 'positionId, exit_price required' });
  }
  const pos = queryOne('SELECT * FROM competition_portfolio WHERE id = ? AND status = ?', [positionId, 'open']);
  if (!pos) return res.status(404).json({ error: 'Open position not found' });

  run(
    "UPDATE competition_portfolio SET status = 'closed', exit_price = ?, exit_date = ? WHERE id = ?",
    [parseFloat(exit_price), exit_date || new Date().toISOString().slice(0, 10), positionId]
  );
  saveDb();
  const pnl = ((exit_price - pos.entry_price) / pos.entry_price * 100).toFixed(2);
  res.json({ message: `Sold ${pos.ticker} @ ${exit_price} (P&L: ${pnl}%)` });
});

router.get('/competition/sell-candidates', (req, res) => {
  const candidates = getCompetitionSellCandidates();
  const latestRunForComp = getLatestPipelineRun();
  res.json({
    count: candidates.length,
    candidates,
    crisis: latestRunForComp?.status === 'crisis',
    pipelineRun: {
      runId: latestRunForComp?.run_id || null,
      rankedAt: latestRunForComp?.started_at || null,
      status: latestRunForComp?.status || null,
    },
    disclaimer: 'Sygnały sprzedaży dla portfela konkursowego — analiza algorytmiczna.',
  });
});

router.get('/competition/history', (req, res) => {
  const trades = query(
    "SELECT * FROM competition_portfolio ORDER BY COALESCE(exit_date, entry_date) DESC LIMIT 100"
  );
  const closed = trades.filter(t => t.status === 'closed');
  const wins = closed.filter(t => t.exit_price > t.entry_price).length;
  const losses = closed.filter(t => t.exit_price <= t.entry_price).length;

  // KPI metrics for offensive mode
  let avgPnlPct = null;
  let avgHoldDays = null;
  let totalRealizedPnl = 0;
  if (closed.length > 0) {
    let sumPnlPct = 0;
    let sumHoldDays = 0;
    for (const t of closed) {
      const pnlPct = ((t.exit_price - t.entry_price) / t.entry_price) * 100;
      sumPnlPct += pnlPct;
      totalRealizedPnl += (t.exit_price - t.entry_price) * t.shares;
      if (t.entry_date && t.exit_date) {
        sumHoldDays += Math.max(1, Math.floor((new Date(t.exit_date) - new Date(t.entry_date)) / 86400000));
      }
    }
    avgPnlPct = Math.round(sumPnlPct / closed.length * 100) / 100;
    avgHoldDays = Math.round(sumHoldDays / closed.length * 10) / 10;
  }

  res.json({
    totalTrades: closed.length,
    wins,
    losses,
    winRate: closed.length > 0 ? Math.round(wins / closed.length * 100) : null,
    avgPnlPct,
    avgHoldDays,
    totalRealizedPnl: Math.round(totalRealizedPnl * 100) / 100,
    trades,
  });
});

// ============================================================
// Alerts — operational anomaly detection
// ============================================================
router.get('/alerts', (req, res) => {
  const alerts = checkAlerts();
  res.json({
    count: alerts.length,
    status: alerts.some(a => a.level === 'critical') ? 'critical' : alerts.length > 0 ? 'warning' : 'ok',
    alerts,
  });
});

// ============================================================
// SLO — last 24h pipeline health history
// ============================================================
router.get('/slo', (req, res) => {
  const runs = query(
    "SELECT run_id, started_at, finished_at, status, universe_total, ingested_ok, features_ok, predicted_ok, ranked_ok, coverage_pct, degraded " +
    "FROM pipeline_runs WHERE started_at >= datetime('now', '-24 hours') ORDER BY started_at DESC"
  );
  const totalRuns = runs.length;
  const okRuns = runs.filter(r => r.status === 'completed' && !r.degraded).length;
  const degradedRuns = runs.filter(r => r.degraded).length;
  const failedRuns = runs.filter(r => r.status !== 'completed').length;

  const worker = getWorkerStatus();
  const alerts = checkAlerts();

  // SLO met: at least 1 run in last 24h AND no critical alerts AND worker running
  const sloMet = totalRuns > 0 && !alerts.some(a => a.level === 'critical') && worker.isRunning;

  res.json({
    sloMet,
    period: '24h',
    totalRuns,
    okRuns,
    degradedRuns,
    failedRuns,
    uptimeSec: worker.startedAt ? Math.round((Date.now() - new Date(worker.startedAt).getTime()) / 1000) : 0,
    workerRunning: worker.isRunning,
    currentMode: getCurrentMode(),
    alertCount: alerts.length,
    alerts,
    runs: runs.map(r => ({
      runId: r.run_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      coveragePct: r.coverage_pct,
      rankedOk: r.ranked_ok,
      universeTotal: r.universe_total,
      degraded: !!r.degraded,
    })),
  });
});

module.exports = router;
