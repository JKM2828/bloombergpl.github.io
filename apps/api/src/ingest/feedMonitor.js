// ============================================================
// Feed Quality Monitor
//
// Checks data freshness, gaps, duplicates per ticker/timeframe.
// Returns health status and auto-fallback recommendation.
// ============================================================
const { query } = require('../db/connection');

const VALID_TIMEFRAMES = ['1d', '1h', '5m'];
const LOOKBACK_BY_TIMEFRAME = {
  '1d': 120,
  '1h': 240,
  '5m': 360,
};

function normalizeTimeframe(timeframe) {
  return VALID_TIMEFRAMES.includes(timeframe) ? timeframe : '1d';
}

function fetchRecentCandlesForTicker(ticker, safeTimeframe, limit) {
  if (safeTimeframe === '1d') {
    return query(
      `SELECT date, open, high, low, close, volume
       FROM (
         SELECT date, open, high, low, close, volume
         FROM candles
         WHERE ticker = ? AND (timeframe = ? OR timeframe IS NULL)
         ORDER BY date DESC
         LIMIT ?
       ) recent
       ORDER BY date ASC`,
      [ticker, '1d', limit]
    );
  }

  return query(
    `SELECT date, open, high, low, close, volume
     FROM (
       SELECT date, open, high, low, close, volume
       FROM candles
       WHERE ticker = ? AND timeframe = ?
       ORDER BY date DESC
       LIMIT ?
     ) recent
     ORDER BY date ASC`,
    [ticker, safeTimeframe, limit]
  );
}

function groupCandlesByTicker(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.ticker)) grouped.set(row.ticker, []);
    grouped.get(row.ticker).push({
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    });
  }
  return grouped;
}

function fetchRecentCandlesForTickers(tickers, safeTimeframe, limit) {
  if (tickers.length === 0) return new Map();

  const placeholders = tickers.map(() => '?').join(', ');

  try {
    if (safeTimeframe === '1d') {
      const rows = query(
        `SELECT ticker, date, open, high, low, close, volume
         FROM (
           SELECT
             ticker,
             date,
             open,
             high,
             low,
             close,
             volume,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
           FROM candles
           WHERE ticker IN (${placeholders}) AND (timeframe = ? OR timeframe IS NULL)
         ) ranked
         WHERE rn <= ?
         ORDER BY ticker ASC, date ASC`,
        [...tickers, '1d', limit]
      );
      return groupCandlesByTicker(rows);
    }

    const rows = query(
      `SELECT ticker, date, open, high, low, close, volume
       FROM (
         SELECT
           ticker,
           date,
           open,
           high,
           low,
           close,
           volume,
           ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
         FROM candles
         WHERE ticker IN (${placeholders}) AND timeframe = ?
       ) ranked
       WHERE rn <= ?
       ORDER BY ticker ASC, date ASC`,
      [...tickers, safeTimeframe, limit]
    );
    return groupCandlesByTicker(rows);
  } catch {
    // Fallback for older SQLite builds without window functions.
    const fallback = new Map();
    for (const ticker of tickers) {
      fallback.set(ticker, fetchRecentCandlesForTicker(ticker, safeTimeframe, limit));
    }
    return fallback;
  }
}

function evaluateFeedFromCandles(candles, safeTimeframe, instrType) {
  const issues = [];

  if (candles.length === 0) {
    return { healthy: false, issues: ['No data'], fallbackRecommended: true, stats: {} };
  }

  // 1. Freshness check
  const lastDate = candles[candles.length - 1].date;
  const now = new Date();
  const last = new Date(lastDate);
  const hoursOld = (now - last) / 3600000;
  const dow = now.getDay();
  const freshThreshold = safeTimeframe === '5m' ? 2 : safeTimeframe === '1h' ? 36 : (dow === 0 || dow === 6 ? 96 : 72);
  if (hoursOld > freshThreshold) {
    issues.push(`Stale data: ${Math.round(hoursOld)}h old (threshold: ${freshThreshold}h)`);
  }

  // 2. Duplicate check (same date appearing more than once)
  const dates = candles.map(c => c.date);
  const uniqueDates = new Set(dates);
  const duplicates = dates.length - uniqueDates.size;
  if (duplicates > 0) {
    issues.push(`${duplicates} duplicate date(s)`);
  }

  // 3. Zero/null price check
  const zeroPrices = candles.filter(c => !c.close || c.close <= 0 || !c.open || c.open <= 0).length;
  if (zeroPrices > 0) {
    issues.push(`${zeroPrices} candle(s) with zero/null prices`);
  }

  // 4. Gap detection (skipped business days for daily data)
  let gaps = 0;
  if (safeTimeframe === '1d' && candles.length >= 10) {
    for (let i = 1; i < Math.min(candles.length, 60); i++) {
      const prev = new Date(candles[candles.length - 1 - i + 1].date);
      const curr = new Date(candles[candles.length - 1 - i].date);
      const diffDays = (prev - curr) / 86400000;
      // Skip weekends — gaps >3 calendar days usually mean missing data
      if (diffDays > 4) gaps++;
    }
    if (gaps > 2) {
      issues.push(`${gaps} suspicious gap(s) in last 60 bars`);
    }
  }

  // 5. Volume health (all zeros = bad)
  // DATA-L1: Skip volume check for INDEX and FUTURES (volume=0 is normal for them)
  const skipVolume = instrType === 'INDEX' || instrType === 'FUTURES';
  const zeroVolBars = candles.slice(-20).filter(c => !c.volume || c.volume === 0).length;
  if (!skipVolume && zeroVolBars > 10) {
    issues.push(`${zeroVolBars}/20 recent bars have zero volume`);
  }

  const healthy = issues.length === 0;
  const fallbackRecommended = !healthy && safeTimeframe === '1h';

  return {
    healthy,
    issues,
    fallbackRecommended,
    stats: {
      totalBars: candles.length,
      lastDate,
      hoursOld: Math.round(hoursOld),
      duplicates,
      gaps,
      zeroPrices,
      zeroVolBars,
    },
  };
}

/**
 * Assess quality of candle data for a given ticker and timeframe.
 * Returns { healthy, issues[], fallbackRecommended, stats }
 */
function assessFeedQuality(ticker, timeframe = '1d', instrType = null) {
  const safeTimeframe = normalizeTimeframe(timeframe);
  const candles = fetchRecentCandlesForTicker(ticker, safeTimeframe, LOOKBACK_BY_TIMEFRAME[safeTimeframe] || 120);
  return evaluateFeedFromCandles(candles, safeTimeframe, instrType);
}

/**
 * Assess feed quality for ALL active instruments.
 * Returns summary + per-ticker details.
 */
function assessAllFeedQuality() {
  const instruments = query("SELECT ticker, type FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','FUTURES','INDEX')");
  const results = { healthy: 0, degraded: 0, missing: 0, details: [] };
  const tickers = instruments.map(i => i.ticker);
  const dailyByTicker = fetchRecentCandlesForTickers(tickers, '1d', LOOKBACK_BY_TIMEFRAME['1d']);
  const intradayByTicker = fetchRecentCandlesForTickers(tickers, '1h', LOOKBACK_BY_TIMEFRAME['1h']);

  for (const inst of instruments) {
    const daily = evaluateFeedFromCandles(dailyByTicker.get(inst.ticker) || [], '1d', inst.type);
    const intraday = evaluateFeedFromCandles(intradayByTicker.get(inst.ticker) || [], '1h', inst.type);

    const status = daily.healthy ? 'healthy' : (daily.stats.totalBars > 0 ? 'degraded' : 'missing');
    results[status]++;

    if (!daily.healthy || !intraday.healthy) {
      results.details.push({
        ticker: inst.ticker,
        type: inst.type,
        daily: { healthy: daily.healthy, issues: daily.issues, bars: daily.stats.totalBars },
        intraday: { healthy: intraday.healthy, issues: intraday.issues, bars: intraday.stats.totalBars, fallback: intraday.fallbackRecommended },
      });
    }
  }

  results.totalInstruments = instruments.length;
  results.healthPct = instruments.length > 0 ? Math.round(results.healthy / instruments.length * 100) : 0;

  return results;
}

module.exports = { assessFeedQuality, assessAllFeedQuality };
