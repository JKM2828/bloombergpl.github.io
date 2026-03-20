// ============================================================
// Ingest pipeline – fetch + validate + store candles for all instruments
//
// Strategy:
//   Phase 1: Stooq JSON batch (chunked, ≤20 HTTP calls for ALL tickers)
//            + retry-missing pass within the batch provider
//   Phase 2: Per-ticker CSV/Yahoo fallback for still-missing tickers
//            Asset-class aware: indices/futures → Stooq CSV only
//
// KPI target: 98%+ live coverage with ≤20 HTTP requests per cycle
// ============================================================
const { query, queryOne, run, saveDb } = require('../db/connection');
const providerManager = require('../providers');
const { fetchIntraday } = require('../providers/stooqIntradayProvider');
const gpwProvider = require('../providers/gpwProvider');

// ---- Dynamic budget: adapts to time-of-day mode ----
const BUDGET_PROFILES = {
  market:     { batch: 15, fallback: 5 },  // aggressive during session
  'off-hours': { batch: 10, fallback: 2 }, // eco mode — save API quota
  night:      { batch: 5,  fallback: 1 },  // minimal — unlikely new data
};

function getBudget() {
  const mode = getCurrentMode();
  return BUDGET_PROFILES[mode] || BUDGET_PROFILES.market;
}

function getCurrentMode() {
  try {
    // Lazy-load to avoid circular deps at module init
    return require('../worker/jobWorker').getCurrentMode();
  } catch {
    return 'market';
  }
}

const FALLBACK_BATCH_SIZE = 3;   // concurrent fetches for CSV/Yahoo fallback
const FALLBACK_DELAY_MS = 2000;  // pause between fallback batches
const TICKER_DELAY_MS = 300;     // pause between individual requests
const JITTER_MAX_MS = 500;       // random jitter added to delays

// ---- Last cycle stats (used by analysis pipeline for degradation) ----
let lastCycleStats = null;
function getLastCycleStats() { return lastCycleStats; }

/**
 * Check if a ticker already has fresh data (last candle = yesterday or today).
 * Provider-agnostic — checks ALL providers for freshness.
 */
function isTickerFresh(ticker) {
  const row = queryOne(
    'SELECT date FROM candles WHERE ticker = ? ORDER BY date DESC LIMIT 1',
    [ticker]
  );
  if (!row || !row.date) return false;
  const lastDate = new Date(row.date);
  const now = new Date();
  const diffDays = Math.floor((now - lastDate) / 86400000);
  if (diffDays <= 0) return true;
  if (diffDays === 1) return true;
  const dow = now.getDay();
  if (dow === 6 && diffDays <= 1) return true;
  if (dow === 0 && diffDays <= 2) return true;
  if (dow === 1 && diffDays <= 3) return true;
  return false;
}

/**
 * Run ingest for all active instruments.
 *
 * Phase 1: Stooq JSON batch — chunked fetch (≤15 HTTP calls)
 * Phase 2: Fallback — per-ticker CSV/Yahoo for missing (≤5 HTTP calls)
 *
 * @param {number} lookbackDays – for fallback CSV fetches (default: 365)
 * @param {boolean} skipFresh – skip tickers that already have up-to-date data
 */
async function ingestAll(lookbackDays = 365, skipFresh = true) {
  const instruments = query('SELECT ticker FROM instruments WHERE active = 1');
  const allTickers = instruments.map((r) => r.ticker);

  // Smart skip: filter out already-fresh tickers
  let skippedFresh = 0;
  let tickers = allTickers;
  if (skipFresh) {
    const stale = [];
    for (const t of allTickers) {
      if (isTickerFresh(t)) {
        skippedFresh++;
      } else {
        stale.push(t);
      }
    }
    console.log(`[ingest] Smart skip: ${skippedFresh}/${allTickers.length} tickers already fresh, ${stale.length} need update`);
    tickers = stale;
  }

  if (tickers.length === 0) {
    console.log('[ingest] All tickers fresh — nothing to do.');
    return {
      total: 0, errors: 0, tickers: 0, skippedFresh,
      batchHits: 0, fallbackHits: 0, noData: 0, rateLimited: 0,
      httpCalls: 0, retryRecovered: 0, batchCoveragePct: 100,
    };
  }

  const budget = getBudget();
  const MAX_BATCH_REQUESTS = budget.batch;
  const MAX_FALLBACK_REQUESTS = budget.fallback;

  let total = 0;
  let errors = 0;
  let rateLimited = 0;
  let noDataTickers = [];
  let batchHits = 0;
  let fallbackHits = 0;
  let totalHttpCalls = 0;
  let retryRecovered = 0;

  // ==== PHASE 1: Stooq JSON batch (chunked, ≤MAX_BATCH_REQUESTS HTTP calls) ====
  console.log(`[ingest] Phase 1: Batch fetch ${tickers.length} tickers via Stooq JSON (budget: ${MAX_BATCH_REQUESTS} calls, mode: ${getCurrentMode()})...`);
  let batchData = new Map();
  try {
    const batchResult = await providerManager.fetchBatchQuotes(tickers, MAX_BATCH_REQUESTS);
    batchData = batchResult.data;
    totalHttpCalls += batchResult.httpCalls;
    retryRecovered = batchResult.retryRecovered;
    console.log(`[ingest] Batch result: ${batchData.size}/${tickers.length} tickers (${batchResult.httpCalls} HTTP calls, ${retryRecovered} retry-recovered)`);
  } catch (err) {
    console.error(`[ingest] Batch fetch error: ${err.message}`);
  }

  const batchCoveragePct = tickers.length > 0
    ? Math.round((batchData.size / tickers.length) * 100 * 10) / 10
    : 0;

  // Store batch results
  for (const [ticker, candle] of batchData) {
    if (!candle || !candle.date || !candle.close || candle.close <= 0) continue;
    const changed = run(
      'INSERT OR REPLACE INTO candles (ticker, date, open, high, low, close, volume, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [ticker, candle.date, candle.open, candle.high, candle.low, candle.close, candle.volume, 'stooq-json']
    );
    total += changed;
    batchHits++;
    run(
      'INSERT INTO ingest_log (provider, ticker, status, rows_inserted, message) VALUES (?, ?, ?, ?, ?)',
      ['stooq-json', ticker, 'ok', changed, `batch: ${candle.date} close=${candle.close}`]
    );
  }

  // ==== PHASE 2: Fallback for tickers NOT in batch result ====
  const missingTickers = tickers.filter(t => !batchData.has(t));
  if (missingTickers.length > 0 && totalHttpCalls < (MAX_BATCH_REQUESTS + MAX_FALLBACK_REQUESTS)) {
    const remainingBudget = (MAX_BATCH_REQUESTS + MAX_FALLBACK_REQUESTS) - totalHttpCalls;
    console.log(`[ingest] Phase 2: Fallback for ${missingTickers.length} missing tickers (budget: ${remainingBudget} calls)...`);
    const dateTo = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dateFrom = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10).replace(/-/g, '');

    let fallbackCallsUsed = 0;

    for (let i = 0; i < missingTickers.length; i += FALLBACK_BATCH_SIZE) {
      if (fallbackCallsUsed >= remainingBudget) {
        console.warn(`[ingest] Fallback budget exhausted (${fallbackCallsUsed}/${remainingBudget}) — stopping.`);
        break;
      }

      const batch = missingTickers.slice(i, i + FALLBACK_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((ticker, idx) => processTicker(ticker, dateFrom, dateTo, idx * TICKER_DELAY_MS))
      );

      fallbackCallsUsed += batch.length;
      totalHttpCalls += batch.length;

      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') {
          const r = results[j].value;
          total += r.inserted;
          if (r.inserted > 0) fallbackHits++;
          if (r.rateLimited) rateLimited++;
          if (r.noData) noDataTickers.push(batch[j]);
        } else {
          errors++;
          run('INSERT INTO ingest_log (provider, ticker, status, rows_inserted, message) VALUES (?, ?, ?, ?, ?)',
            ['unknown', batch[j], 'error', 0, results[j].reason?.message || 'Unknown error']);
        }
      }

      if (rateLimited >= FALLBACK_BATCH_SIZE) {
        console.warn('[ingest] All fallback providers exhausted — stopping.');
        break;
      }
      if (i + FALLBACK_BATCH_SIZE < missingTickers.length) {
        await sleep(FALLBACK_DELAY_MS + Math.floor(Math.random() * JITTER_MAX_MS));
      }
    }
  } else if (missingTickers.length > 0) {
    console.warn(`[ingest] Skipping fallback — HTTP budget exhausted (${totalHttpCalls} calls used).`);
  }

  // Auto-deactivate tickers with repeated no-data (provider-agnostic)
  if (noDataTickers.length > 0) {
    for (const ticker of noDataTickers) {
      const failCount = query(
        'SELECT COUNT(*) as c FROM ingest_log WHERE ticker = ? AND rows_inserted = 0 ORDER BY created_at DESC LIMIT 3',
        [ticker]
      );
      if ((failCount[0]?.c || 0) >= 3) {
        run('UPDATE instruments SET active = 0 WHERE ticker = ?', [ticker]);
        console.warn(`[ingest] ${ticker}: auto-deactivated (no data after 3+ attempts)`);
      }
    }
  }

  // Log coverage metrics
  const liveCoverage = batchHits + fallbackHits;
  const liveCoveragePct = tickers.length > 0
    ? Math.round((liveCoverage / tickers.length) * 100 * 10) / 10
    : 0;

  saveDb();
  console.log(`[ingest] ======== INGEST SUMMARY ========`);
  console.log(`[ingest] Instruments: ${allTickers.length} total, ${skippedFresh} skipped-fresh, ${tickers.length} fetched`);
  console.log(`[ingest] Coverage: ${liveCoverage}/${tickers.length} (${liveCoveragePct}%) — batch ${batchHits}, fallback ${fallbackHits}`);
  console.log(`[ingest] Batch coverage: ${batchData.size}/${tickers.length} (${batchCoveragePct}%), retry-recovered: ${retryRecovered}`);
  console.log(`[ingest] HTTP calls: ${totalHttpCalls} (budget: ${MAX_BATCH_REQUESTS + MAX_FALLBACK_REQUESTS})`);
  console.log(`[ingest] New candles: ${total}, errors: ${errors}, no-data: ${noDataTickers.length}, rate-limited: ${rateLimited}`);
  console.log(`[ingest] ================================`);

  const result = {
    total, errors, tickers: tickers.length, skippedFresh,
    batchHits, fallbackHits, noData: noDataTickers.length, rateLimited,
    httpCalls: totalHttpCalls, retryRecovered, batchCoveragePct, liveCoveragePct,
    mode: getCurrentMode(), timestamp: new Date().toISOString(),
  };
  lastCycleStats = result;
  return result;
}

/**
 * Process a single ticker: fetch → validate → store.
 */
async function processTicker(ticker, dateFrom, dateTo, delayMs = 0) {
  if (delayMs > 0) await sleep(delayMs);

  const result = await providerManager.fetchCandles(ticker, dateFrom, dateTo);

  // Handle rate-limit: log and return early (don't treat as no_data)
  if (result.rateLimited) {
    const msg = `Daily limit exceeded; cooldown until ${result.cooldownUntil || 'midnight'}`;
    run(
      'INSERT INTO ingest_log (provider, ticker, status, rows_inserted, message) VALUES (?, ?, ?, ?, ?)',
      [result.provider || 'stooq', ticker, 'rate_limited', 0, msg]
    );
    return { inserted: 0, noData: false, rateLimited: true };
  }

  const candles = validateCandles(result.candles);

  let inserted = 0;
  for (const c of candles) {
    const changed = run(
      'INSERT OR REPLACE INTO candles (ticker, date, open, high, low, close, volume, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [ticker, c.date, c.open, c.high, c.low, c.close, c.volume, result.provider]
    );
    inserted += changed;
  }

  const noData = candles.length === 0;
  run(
    'INSERT INTO ingest_log (provider, ticker, status, rows_inserted, message) VALUES (?, ?, ?, ?, ?)',
    [result.provider, ticker, noData ? 'no_data' : 'ok', inserted, `${candles.length} candles, ${inserted} new`]
  );
  if (!noData) {
    console.log(`[ingest] ${ticker}: ${inserted} new candles (${result.provider})`);
  }
  return { inserted, noData, rateLimited: false };
}

/**
 * Run incremental ingest – batch JSON (1 call) + 5-day fallback.
 * Skips already-fresh tickers to minimize requests.
 */
async function ingestIncremental() {
  return ingestAll(5, true);
}

/**
 * Validate a single ticker against Stooq – returns true if data exists.
 */
async function validateTicker(ticker) {
  try {
    const dateTo = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dateFrom = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    const result = await providerManager.fetchCandles(ticker, dateFrom, dateTo);
    return result.candles && result.candles.length > 0;
  } catch {
    return false;
  }
}

// ---- Validation ----
function validateCandles(candles) {
  if (!candles || candles.length === 0) return [];

  // First pass: basic validity
  const valid = candles.filter((c) => {
    if (!c.date || isNaN(c.close) || isNaN(c.open)) return false;
    if (c.high < c.low) return false;
    if (c.close <= 0 || c.open <= 0) return false;
    if (c.high <= 0 || c.low <= 0) return false;
    return true;
  });

  // Second pass: outlier detection (reject >50% day-over-day jumps on close)
  if (valid.length < 2) return valid;
  const cleaned = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    const prev = cleaned[cleaned.length - 1].close;
    const curr = valid[i].close;
    const change = Math.abs(curr - prev) / prev;
    if (change > 0.50) {
      console.warn(`[validate] Outlier rejected: ${valid[i].date} close=${curr} (${(change*100).toFixed(1)}% jump from ${prev})`);
      continue;
    }
    cleaned.push(valid[i]);
  }
  return cleaned;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  const { migrate } = require('../db/migrate');
  const { seed } = require('../db/seed');
  (async () => {
    await migrate();
    await seed();
    await ingestAll();
    process.exit(0);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

/**
 * Ingest 1-hour intraday candles for the most liquid instruments.
 * Uses a small HTTP budget to avoid exhausting the daily Stooq limit.
 * @param {number} maxTickers – max tickers to fetch (default: top 20 + futures)
 * @returns {Object} ingest summary
 */
async function ingestIntraday(maxTickers = 22) {
  // Select top liquid stocks + all futures
  const instruments = query(`
    SELECT i.ticker, i.type FROM instruments i WHERE i.active = 1
    AND (i.type = 'FUTURES' OR i.ticker IN (
      SELECT ticker FROM (
        SELECT c.ticker, AVG(c.volume) as avg_vol
        FROM candles c
        WHERE c.timeframe = '1d' AND c.date >= date('now', '-30 days')
        GROUP BY c.ticker
        ORDER BY avg_vol DESC
        LIMIT ?
      )
    ))
  `, [maxTickers]);

  const dateTo = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dateFrom = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');

  let total = 0, errors = 0, fetched = 0;

  for (const inst of instruments) {
    try {
      const candles = await fetchIntraday(inst.ticker, dateFrom, dateTo);
      if (!candles || candles.length === 0) continue;

      const valid = validateCandles(candles);
      let inserted = 0;
      for (const c of valid) {
        const changed = run(
          `INSERT OR REPLACE INTO candles (ticker, date, open, high, low, close, volume, provider, timeframe)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [inst.ticker, c.date, c.open, c.high, c.low, c.close, c.volume, 'stooq-intraday', '1h']
        );
        inserted += changed;
      }
      total += inserted;
      fetched++;
      if (inserted > 0) {
        console.log(`[intraday] ${inst.ticker}: ${inserted} new 1h candles`);
      }
      // Small delay between tickers
      await sleep(500 + Math.floor(Math.random() * 300));
    } catch (err) {
      if (err.code === 'STOOQ_RATE_LIMIT') {
        console.warn('[intraday] Rate-limited — stopping intraday ingest.');
        break;
      }
      errors++;
      console.warn(`[intraday] ${inst.ticker}: ${err.message}`);
    }
  }

  saveDb();
  console.log(`[intraday] Done: ${fetched}/${instruments.length} tickers, ${total} new candles, ${errors} errors`);
  return { total, fetched, attempted: instruments.length, errors, timeframe: '1h' };
}

/**
 * Ingest 5-minute intraday candles from GPW API for all active instruments.
 * Used for live chart feeds. Fetches last 5 days of 5m bars.
 * @param {number} maxTickers – max tickers to fetch (default: all active)
 * @returns {Object} ingest summary
 */
async function ingestIntraday5m(maxTickers = 200) {
  if (!gpwProvider.hasBudget()) {
    console.warn('[intraday-5m] GPW budget exhausted — skipping.');
    return { total: 0, fetched: 0, attempted: 0, errors: 0, timeframe: '5m' };
  }

  // Select top liquid stocks + all futures + indices
  const instruments = query(`
    SELECT i.ticker, i.type FROM instruments i WHERE i.active = 1
    AND (i.type IN ('FUTURES','INDEX') OR i.ticker IN (
      SELECT ticker FROM (
        SELECT c.ticker, AVG(c.volume) as avg_vol
        FROM candles c
        WHERE c.timeframe = '1d' AND c.date >= date('now', '-30 days')
        GROUP BY c.ticker
        ORDER BY avg_vol DESC
        LIMIT ?
      )
    ))
  `, [maxTickers]);

  const dateTo = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dateFrom = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');

  let total = 0, errors = 0, fetched = 0;

  for (const inst of instruments) {
    try {
      const candles = await gpwProvider.fetchIntraday(inst.ticker, dateFrom, dateTo);
      if (!candles || candles.length === 0) continue;

      const valid = validateCandles(candles);
      let inserted = 0;
      for (const c of valid) {
        const changed = run(
          `INSERT OR REPLACE INTO candles (ticker, date, open, high, low, close, volume, provider, timeframe)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [inst.ticker, c.date, c.open, c.high, c.low, c.close, c.volume, 'gpw', '5m']
        );
        inserted += changed;
      }
      total += inserted;
      fetched++;
      if (inserted > 0) {
        console.log(`[intraday-5m] ${inst.ticker}: ${inserted} new 5m candles`);
      }
      await sleep(200 + Math.floor(Math.random() * 200));
    } catch (err) {
      if (err.code === 'GPW_RATE_LIMIT' || err.code === 'GPW_BUDGET_EXHAUSTED') {
        console.warn('[intraday-5m] GPW rate-limited — stopping.');
        break;
      }
      if (err.code === 'GPW_NO_KEY') {
        console.warn('[intraday-5m] GPW API key not configured — skipping.');
        break;
      }
      errors++;
      console.warn(`[intraday-5m] ${inst.ticker}: ${err.message}`);
    }
  }

  saveDb();
  console.log(`[intraday-5m] Done: ${fetched}/${instruments.length} tickers, ${total} new candles, ${errors} errors`);
  return { total, fetched, attempted: instruments.length, errors, timeframe: '5m' };
}

module.exports = { ingestAll, ingestIncremental, ingestIntraday, ingestIntraday5m, validateTicker, getLastCycleStats };
