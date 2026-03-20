// ============================================================
// Feed Quality Monitor
//
// Checks data freshness, gaps, duplicates per ticker/timeframe.
// Returns health status and auto-fallback recommendation.
// ============================================================
const { query, queryOne, run, saveDb } = require('../db/connection');

/**
 * Assess quality of candle data for a given ticker and timeframe.
 * Returns { healthy, issues[], fallbackRecommended, stats }
 */
function assessFeedQuality(ticker, timeframe = '1d') {
  const issues = [];

  const tfClause = timeframe === '1d'
    ? "(timeframe = '1d' OR timeframe IS NULL)"
    : timeframe === '5m'
      ? "timeframe = '5m'"
      : `timeframe = '${timeframe === '1h' ? '1h' : '1d'}'`;

  const candles = query(
    `SELECT date, open, high, low, close, volume FROM candles WHERE ticker = ? AND ${tfClause} ORDER BY date ASC`,
    [ticker]
  );

  if (candles.length === 0) {
    return { healthy: false, issues: ['No data'], fallbackRecommended: true, stats: {} };
  }

  // 1. Freshness check
  const lastDate = candles[candles.length - 1].date;
  const now = new Date();
  const last = new Date(lastDate);
  const hoursOld = (now - last) / 3600000;
  const dow = now.getDay();
  const freshThreshold = timeframe === '5m' ? 2 : timeframe === '1h' ? 36 : (dow === 0 || dow === 6 ? 96 : 72);
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
  if (timeframe === '1d' && candles.length >= 10) {
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
  const zeroVolBars = candles.slice(-20).filter(c => !c.volume || c.volume === 0).length;
  if (zeroVolBars > 10) {
    issues.push(`${zeroVolBars}/20 recent bars have zero volume`);
  }

  const healthy = issues.length === 0;
  const fallbackRecommended = !healthy && timeframe === '1h';

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
 * Assess feed quality for ALL active instruments.
 * Returns summary + per-ticker details.
 */
function assessAllFeedQuality() {
  const instruments = query("SELECT ticker, type FROM instruments WHERE active = 1 AND type IN ('STOCK','ETF','FUTURES','INDEX')");
  const results = { healthy: 0, degraded: 0, missing: 0, details: [] };

  for (const inst of instruments) {
    const daily = assessFeedQuality(inst.ticker, '1d');
    const intraday = assessFeedQuality(inst.ticker, '1h');

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
